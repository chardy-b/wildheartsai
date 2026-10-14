import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import type { Db } from "@/lib/db/types";
import { wildcardFile } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import { sealField, unsealField, userKeysFor } from "@/lib/crypto/user-keys";
import { beginUpload, completeUpload, deleteFile, listFiles, readFile, storeFile, uploadPart } from "./wildcards-store";
import { MAX_FILES, MAX_STORAGE_BYTES } from "./wildcards";

let db: Db;
const kek = randomBytes(32);
const blobs = new Map<string, Buffer>();
const objects = {
  async put(key: string, bytes: Buffer) { blobs.set(key, bytes); },
  async get(key: string) { const bytes = blobs.get(key); if (!bytes) throw new Error("Missing object"); return bytes; },
  async delete(key: string) { blobs.delete(key); },
};
const bytes = Buffer.from("hello");
const digest = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const sha256 = digest(bytes);
beforeAll(async () => { db = await createTestDb(); });
async function person() { return createTestUser(db, `dedup_${randomUUID()}`); }
async function upload(user: string, name = "note.txt", path = "Records/Visits/note.txt", content = bytes) {
  const start = await beginUpload(db, kek, user, name, content.length, path);
  await uploadPart(db, kek, user, start.id, 0, content, objects);
  expect(await completeUpload(db, kek, user, start.id, objects)).toEqual({ duplicate: false });
  return start.id;
}
function simultaneousWrites() {
  let writes = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  return { ...objects, async put(key: string, content: Buffer) {
    await objects.put(key, content);
    if (++writes === 2) release();
    await barrier;
  } };
}

describe("private document content deduplication", () => {
  it("skips identical bytes regardless of filename, folder, or case and preserves the first upload", async () => {
    const user = await person();
    const id = await upload(user);
    const [first] = await listFiles(db, kek, user);
    for (const [name, path] of [["note.txt", "Records/Visits/note.txt"], ["renamed.TXT", "records/labs/renamed.TXT"], ["copy.txt", undefined]]) {
      const result = await beginUpload(db, kek, user, name!, bytes.length, path, sha256, objects);
      expect(result).toMatchObject({ id, duplicate: true });
    }
    expect(await listFiles(db, kek, user)).toEqual([first]);
    expect(first.sizeBytes).toBe(bytes.length);
    expect("sha256" in first).toBe(false);
    expect("sha256" in (await readFile(db, kek, user, id, objects))!).toBe(false);
    const [raw] = await db.select().from(wildcardFile).where(eq(wildcardFile.id, id));
    expect(raw.sealedMetadata).not.toContain(sha256);
    expect(blobs.has(raw.objectKey)).toBe(true);
  });

  it("keeps same-path files when their contents differ, even with equal sizes", async () => {
    const user = await person();
    const a = await upload(user);
    const b = await upload(user, "note.txt", "Records/Visits/note.txt", Buffer.from("world"));
    expect(a).not.toBe(b);
    expect(await listFiles(db, kek, user)).toHaveLength(2);
    expect((await readFile(db, kek, user, a, objects))?.bytes).toEqual(bytes);
    expect((await readFile(db, kek, user, b, objects))?.bytes).toEqual(Buffer.from("world"));
  });

  it("never deduplicates across owners or leaks another owner's match", async () => {
    const owner = await person(), other = await person();
    const first = await upload(owner);
    const start = await beginUpload(db, kek, other, "note.txt", bytes.length, undefined, sha256, objects);
    expect(start.duplicate).toBe(false);
    expect(start.id).not.toBe(first);
    await uploadPart(db, kek, other, start.id, 0, bytes, objects);
    expect(await completeUpload(db, kek, other, start.id, objects)).toEqual({ duplicate: false });
    expect(await listFiles(db, kek, owner)).toHaveLength(1);
    expect(await listFiles(db, kek, other)).toHaveLength(1);
  });

  it("computes hashes from actual bytes rather than trusting a client hint", async () => {
    const user = await person();
    const start = await beginUpload(db, kek, user, "note.txt", bytes.length, undefined, "0".repeat(64), objects);
    await uploadPart(db, kek, user, start.id, 0, bytes, objects);
    await completeUpload(db, kek, user, start.id, objects);
    expect((await beginUpload(db, kek, user, "copy.txt", bytes.length, undefined, sha256, objects)).duplicate).toBe(true);
    const next = await beginUpload(db, kek, user, "other.txt", bytes.length, undefined, "0".repeat(64), objects);
    expect(next.duplicate).toBe(false);
    await deleteFile(db, user, next.id, objects);
  });

  it("detects duplicates without a client hash, removes temporary objects, releases quota, and supports lost-response retries", async () => {
    const user = await person();
    const first = await upload(user);
    const start = await beginUpload(db, kek, user, "copy.txt", bytes.length);
    await uploadPart(db, kek, user, start.id, 0, bytes, objects);
    const [pending] = await db.select().from(wildcardFile).where(eq(wildcardFile.id, start.id));
    expect(await completeUpload(db, kek, user, start.id, objects, sha256)).toEqual({ duplicate: true });
    expect(await completeUpload(db, kek, user, start.id, objects, sha256)).toEqual({ duplicate: true });
    expect(await db.select().from(wildcardFile).where(eq(wildcardFile.id, start.id))).toEqual([]);
    expect(blobs.has(pending.objectKey)).toBe(false);
    expect(Object.values(pending.uploadParts!).every((key) => !blobs.has(key))).toBe(true);
    expect((await listFiles(db, kek, user)).map((file) => file.id)).toEqual([first]);
    const other = await person();
    await expect(completeUpload(db, kek, other, start.id, objects, sha256)).rejects.toThrow("not found");
    await expect(completeUpload(db, kek, user, start.id, objects, "0".repeat(64))).rejects.toThrow("not found");
  });

  it("publishes only one file when two chunked uploads complete simultaneously", async () => {
    const user = await person();
    const a = await beginUpload(db, kek, user, "a.txt", bytes.length);
    const b = await beginUpload(db, kek, user, "b.txt", bytes.length);
    await uploadPart(db, kek, user, a.id, 0, bytes, objects);
    await uploadPart(db, kek, user, b.id, 0, bytes, objects);
    const concurrent = simultaneousWrites();
    const results = await Promise.all([completeUpload(db, kek, user, a.id, concurrent), completeUpload(db, kek, user, b.id, concurrent)]);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    const files = await listFiles(db, kek, user);
    expect(files).toHaveLength(1);
    expect((await readFile(db, kek, user, files[0].id, objects))?.bytes).toEqual(bytes);
  });

  it("deduplicates the legacy upload endpoint, including simultaneous uploads", async () => {
    const user = await person();
    const concurrent = simultaneousWrites();
    const results = await Promise.all([storeFile(db, kek, user, "a.txt", bytes, concurrent), storeFile(db, kek, user, "b.txt", bytes, concurrent)]);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(await storeFile(db, kek, user, "c.txt", bytes, objects)).toEqual({ duplicate: true });
    expect(await listFiles(db, kek, user)).toHaveLength(1);
  });

  it("deduplicates concurrent uploads across legacy and chunked endpoints", async () => {
    const user = await person();
    const start = await beginUpload(db, kek, user, "a.txt", bytes.length);
    await uploadPart(db, kek, user, start.id, 0, bytes, objects);
    const concurrent = simultaneousWrites();
    const results = await Promise.all([completeUpload(db, kek, user, start.id, concurrent), storeFile(db, kek, user, "b.txt", bytes, concurrent)]);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(await listFiles(db, kek, user)).toHaveLength(1);
  });

  it.each(["files", "bytes"])("skips duplicates even at the %s quota without reserving more storage", async (quota) => {
    const user = await person();
    const id = await upload(user);
    const fillers = quota === "files" ? MAX_FILES - 1 : 1;
    await db.insert(wildcardFile).values(Array.from({ length: fillers }, () => ({
      userId: user, sealedMetadata: "quota fixture of a different size", objectKey: randomUUID(),
      sizeBytes: quota === "files" ? 1 : MAX_STORAGE_BYTES - bytes.length,
    })));
    const before = await db.select().from(wildcardFile).where(eq(wildcardFile.userId, user));
    expect(await beginUpload(db, kek, user, "copy.txt", bytes.length, undefined, sha256, objects)).toMatchObject({ id, duplicate: true });
    expect(await storeFile(db, kek, user, "copy.txt", bytes, objects)).toEqual({ duplicate: true });
    expect(await db.select().from(wildcardFile).where(eq(wildcardFile.userId, user))).toEqual(before);
    await expect(beginUpload(db, kek, user, "different.txt", bytes.length, undefined, digest(Buffer.from("world")), objects)).rejects.toThrow(quota === "files" ? "limit is 200" : "Delete files to free space");
  });

  it("backfills legacy hashes from encrypted originals while preserving their names and locations", async () => {
    const user = await person();
    const id = await upload(user);
    await asUser(db, user, async (tx) => {
      const keys = await userKeysFor(tx, kek, user, new Date());
      await tx.update(wildcardFile).set({ sealedMetadata: sealField(keys,
        JSON.stringify({ name: "note.txt", relativePath: "Records/Visits/note.txt", type: "text/plain; charset=utf-8" }),
        { table: "wildcard_file", rowId: id, field: "metadata" }) }).where(eq(wildcardFile.id, id));
    });
    const before = (await listFiles(db, kek, user))[0];
    expect(await beginUpload(db, kek, user, "renamed.txt", bytes.length, undefined, sha256, objects)).toMatchObject({ id, duplicate: true });
    expect(await listFiles(db, kek, user)).toEqual([before]);
    const [raw] = await db.select().from(wildcardFile).where(eq(wildcardFile.id, id));
    await asUser(db, user, async (tx) => {
      const keys = await userKeysFor(tx, kek, user, new Date());
      const meta = JSON.parse(unsealField(keys, raw.sealedMetadata, { table: "wildcard_file", rowId: id, field: "metadata" }));
      expect(meta.sha256).toBe(sha256);
    });
    expect(raw.sealedMetadata).not.toContain(sha256);
  });

  it("allows uploading content again after its original is deleted", async () => {
    const user = await person();
    const id = await upload(user);
    await deleteFile(db, user, id, objects);
    const start = await beginUpload(db, kek, user, "note.txt", bytes.length, undefined, sha256, objects);
    expect(start.duplicate).toBe(false);
    await uploadPart(db, kek, user, start.id, 0, bytes, objects);
    expect(await completeUpload(db, kek, user, start.id, objects)).toEqual({ duplicate: false });
  });
});
