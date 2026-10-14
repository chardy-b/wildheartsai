import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import type { Db } from "@/lib/db/types";
import { wildcardFile } from "@/lib/db/schema";
import { beginUpload, cleanupExpiredUploads, fileUsage, completeUpload, deleteFile, listFiles, readFile, uploadPart } from "./wildcards-store";
import { MAX_FILE_BYTES, MAX_STORAGE_BYTES, UPLOAD_CHUNK_BYTES } from "./wildcards";

let db: Db;
const kek = randomBytes(32);
const blobs = new Map<string, Buffer>();
const objects = {
  async put(key: string, bytes: Buffer) { blobs.set(key, bytes); },
  async get(key: string) { const bytes = blobs.get(key); if (!bytes) throw new Error("Missing"); return bytes; },
  async delete(key: string) { blobs.delete(key); },
};
beforeAll(async () => { db = await createTestDb(); });
async function person() { return createTestUser(db, `upload_${randomUUID()}`); }
async function parts(user: string, id: string, bytes: Buffer) {
  for (let offset = 0, index = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES, index++) {
    await uploadPart(db, kek, user, id, index, bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES), objects);
  }
}

describe("large private uploads", () => {
  it("reuses a reservation and received pieces after lost start responses", async () => {
    const user = await person(), id = randomUUID();
    await beginUpload(db, kek, user, "note.txt", 5, id);
    await parts(user, id, Buffer.from("hello"));
    const retried = await beginUpload(db, kek, user, "note.txt", 5, id);
    expect(retried).toMatchObject({ id, status: "pending", parts: ["0"] });
    expect(await fileUsage(db, user)).toEqual({ count: 1, bytes: 5 });
    await expect(beginUpload(db, kek, user, "different.txt", 5, id)).rejects.toThrow("different file");
  });
  it("reports finalization in progress without cancelling the original save", async () => {
    const user = await person();
    const { id } = await beginUpload(db, kek, user, "note.txt", 5);
    await parts(user, id, Buffer.from("hello"));
    let release!: () => void;
    let entered!: () => void;
    const saving = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = completeUpload(db, kek, user, id, { ...objects, async get(key) { entered(); await gate; return objects.get(key); } });
    await saving;
    await expect(completeUpload(db, kek, user, id, objects)).rejects.toMatchObject({ status: 202 });
    release(); await original;
    expect((await readFile(db, kek, user, id, objects))?.bytes.toString()).toBe("hello");
  });
  it("reclaims expired reservations and their ciphertext without touching active files", async () => {
    const user = await person();
    const { id } = await beginUpload(db, kek, user, "old.txt", 5);
    await parts(user, id, Buffer.from("hello"));
    const [old] = await db.select().from(wildcardFile).where(eq(wildcardFile.id, id));
    await db.update(wildcardFile).set({ uploadedAt: new Date(Date.now() - 61 * 60_000) }).where(eq(wildcardFile.id, id));
    const active = await beginUpload(db, kek, user, "new.txt", 5);
    await cleanupExpiredUploads(db, user, objects);
    expect(await fileUsage(db, user)).toEqual({ count: 1, bytes: 5 });
    expect((await listFiles(db, kek, user))[0].id).toBe(active.id);
    expect(Object.values(old.uploadParts!).every((key) => !blobs.has(key))).toBe(true);
  });
  it("paginates metadata while counting all reserved bytes, including totals above 2 GB", async () => {
    const user = await person();
    for (let i = 0; i < 85; i++) await beginUpload(db, kek, user, `${i}.pdf`, MAX_FILE_BYTES);
    expect(await listFiles(db, kek, user)).toHaveLength(50);
    expect(await listFiles(db, kek, user, 2)).toHaveLength(35);
    expect(await fileUsage(db, user)).toEqual({ count: 85, bytes: 85 * MAX_FILE_BYTES });
  });

  it("round trips a phone photo at the full file-size limit and cleans up encrypted temporary pieces", async () => {
    const user = await person();
    const bytes = Buffer.alloc(MAX_FILE_BYTES, 0x61); bytes.set([255, 216, 255]);
    const started = await beginUpload(db, kek, user, "synthetic.MP.jpg", bytes.length);
    expect(started.chunkBytes).toBe(UPLOAD_CHUNK_BYTES);
    await parts(user, started.id, bytes);
    const [pending] = await db.select().from(wildcardFile).where(eq(wildcardFile.id, started.id));
    expect(pending.status).toBe("pending");
    const temporaryKeys = Object.values(pending.uploadParts!);
    for (const key of temporaryKeys) expect(blobs.get(key)![0]).toBe(1);
    expect(await readFile(db, kek, user, started.id, objects)).toBeNull();
    await completeUpload(db, kek, user, started.id, objects);
    const downloaded = await readFile(db, kek, user, started.id, objects);
    expect(downloaded?.bytes.equals(bytes)).toBe(true);
    expect(downloaded?.name).toBe("synthetic.MP.jpg");
    expect(temporaryKeys.every((key) => !blobs.has(key))).toBe(true);
    await completeUpload(db, kek, user, started.id, objects);
    expect((await listFiles(db, kek, user))[0].status).toBe("ready");
    await deleteFile(db, user, started.id, objects);
    expect(blobs.has(pending.objectKey)).toBe(false);
  }, 30_000);

  it("separates empty, too-large, unsupported-type, and quota errors before storing data", async () => {
    const user = await person();
    expect(() => beginUpload(db, kek, user, "empty.txt", 0)).toThrow("empty (0 bytes)");
    expect(() => beginUpload(db, kek, user, "huge.jpg", MAX_FILE_BYTES + 1024 * 1024)).toThrow("26.0 MB; the limit is 25.0 MB");
    expect(() => beginUpload(db, kek, user, "unsafe.svg", 10)).toThrow("type is not supported");
    await db.insert(wildcardFile).values(Array.from({ length: Math.ceil(MAX_STORAGE_BYTES / MAX_FILE_BYTES) }, (_, index) => ({ userId: user, sealedMetadata: "test", objectKey: randomUUID(), sizeBytes: Math.min(MAX_FILE_BYTES, MAX_STORAGE_BYTES - index * MAX_FILE_BYTES) })));
    await expect(beginUpload(db, kek, user, "extra.txt", 1)).rejects.toThrow("10.0 GB of 10.0 GB used");
  });

  it("rejects cross-account writes, finalization, reads, and deletion", async () => {
    const owner = await person(), other = await person();
    const { id } = await beginUpload(db, kek, owner, "private.txt", 5);
    await expect(uploadPart(db, kek, other, id, 0, Buffer.from("hello"), objects)).rejects.toThrow("not found");
    await expect(completeUpload(db, kek, other, id, objects)).rejects.toThrow("not found");
    expect(await readFile(db, kek, other, id, objects)).toBeNull();
    expect(await deleteFile(db, other, id, objects)).toBe(false);
  });

  it("requires exact piece sizes and every piece before finalizing", async () => {
    const user = await person();
    const { id } = await beginUpload(db, kek, user, "note.txt", UPLOAD_CHUNK_BYTES + 2);
    await expect(uploadPart(db, kek, user, id, -1, Buffer.from("a"), objects)).rejects.toThrow("Invalid upload piece");
    await expect(uploadPart(db, kek, user, id, 2, Buffer.from("a"), objects)).rejects.toThrow("Invalid upload piece");
    await expect(uploadPart(db, kek, user, id, 0, Buffer.from("a"), objects)).rejects.toThrow("incomplete");
    await expect(completeUpload(db, kek, user, id, objects)).rejects.toThrow("not arrived");
    await deleteFile(db, user, id, objects);
  });

  it("retries a piece without duplicating files and removes superseded ciphertext", async () => {
    const user = await person();
    const { id } = await beginUpload(db, kek, user, "note.txt", 5);
    await parts(user, id, Buffer.from("hello"));
    const [row] = await db.select().from(wildcardFile).where(eq(wildcardFile.id, id));
    const old = row.uploadParts!["0"];
    await parts(user, id, Buffer.from("world"));
    expect(blobs.has(old)).toBe(false);
    await completeUpload(db, kek, user, id, objects);
    expect((await readFile(db, kek, user, id, objects))?.bytes.toString()).toBe("world");
    expect(await listFiles(db, kek, user)).toHaveLength(1);
  });

  it("validates UTF-8 across chunk boundaries and rejects forged file types on completion", async () => {
    const user = await person();
    const bytes = Buffer.concat([Buffer.alloc(UPLOAD_CHUNK_BYTES - 1, 0x61), Buffer.from("✓")]);
    const { id } = await beginUpload(db, kek, user, "note.txt", bytes.length);
    await parts(user, id, bytes);
    await completeUpload(db, kek, user, id, objects);
    expect((await readFile(db, kek, user, id, objects))?.bytes.equals(bytes)).toBe(true);
    const forged = await beginUpload(db, kek, user, "fake.pdf", 5);
    await parts(user, forged.id, Buffer.from("hello"));
    await expect(completeUpload(db, kek, user, forged.id, objects)).rejects.toThrow("contents do not match");
    expect((await listFiles(db, kek, user)).map((file) => file.id)).not.toContain(forged.id);
  });

  it("rejects tampered ciphertext, cleans up incomplete uploads, and releases quota", async () => {
    const user = await person();
    const { id } = await beginUpload(db, kek, user, "note.txt", 5);
    await parts(user, id, Buffer.from("hello"));
    const [row] = await db.select().from(wildcardFile).where(eq(wildcardFile.id, id));
    const key = row.uploadParts!["0"];
    blobs.get(key)![30] ^= 1;
    await expect(completeUpload(db, kek, user, id, objects)).rejects.toThrow();
    expect(blobs.has(key)).toBe(false);
    expect(await listFiles(db, kek, user)).toEqual([]);
  });

  it("refuses expired uploads and removes in-flight parts if the owner cancels", async () => {
    const user = await person();
    const expired = await beginUpload(db, kek, user, "note.txt", 5);
    await db.update(wildcardFile).set({ uploadedAt: new Date(Date.now() - 61 * 60_000) }).where(eq(wildcardFile.id, expired.id));
    await expect(parts(user, expired.id, Buffer.from("hello"))).rejects.toThrow("expired");
    const active = await beginUpload(db, kek, user, "note.txt", 5);
    let partKey = "";
    await expect(uploadPart(db, kek, user, active.id, 0, Buffer.from("hello"), {
      ...objects, async put(key, bytes) { partKey = key; await objects.put(key, bytes); await deleteFile(db, user, active.id, objects); },
    })).rejects.toThrow("not found");
    expect(blobs.has(partKey)).toBe(false);
  });
});
