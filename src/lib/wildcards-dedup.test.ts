import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import type { Db } from "./db/types";
import { wildcardFile } from "./db/schema";
import { beginUpload, completeUpload, deleteFile, fileUsage, listFiles, storeFile, uploadPart } from "./wildcards-store";
import { MAX_FILES } from "./wildcards";

let db: Db;
const kek = randomBytes(32);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const blobs = new Map<string, Buffer>();
let reads = 0, writes = 0;
const objects = {
  async put(key: string, bytes: Buffer) { writes++; blobs.set(key, bytes); },
  async get(key: string) { reads++; const bytes = blobs.get(key); if (!bytes) throw new Error("Missing object"); return bytes; },
  async delete(key: string) { blobs.delete(key); },
};
beforeAll(async () => { db = await createTestDb(); });
const person = () => createTestUser(db, randomUUID());
async function upload(user: string, text = "hello", name = "note.txt") {
  const result = await beginUpload(db, kek, user, name, Buffer.byteLength(text), undefined, randomUUID(), sha(text), objects);
  if (result.status !== "ready") {
    await uploadPart(db, kek, user, result.id, 0, Buffer.from(text), objects);
    await completeUpload(db, kek, user, result.id, objects);
  }
  return result.id;
}

describe("account-scoped content duplicates", () => {
  it("skips across devices, names, and folders with no object transfers or additional quota, even when full", async () => {
    const user = await person(); const id = await upload(user);
    await db.execute(sql`insert into wildcard_file (id, user_id, sealed_metadata, object_key, size_bytes) select gen_random_uuid(), ${user}, 'test', gen_random_uuid()::text, 1 from generate_series(1, ${MAX_FILES - 1})`);
    const before = { reads, writes, usage: await fileUsage(db, user) };
    const second = await beginUpload(db, kek, user, "renamed.txt", 5, "Elsewhere/renamed.txt", randomUUID(), sha("hello"), objects);
    expect(second).toMatchObject({ id, status: "ready", skipped: true });
    expect({ reads, writes }).toEqual({ reads: before.reads, writes: before.writes });
    expect(await fileUsage(db, user)).toEqual(before.usage);
  });
  it("isolates accounts and stores keyed fingerprints rather than raw or shared content hashes", async () => {
    const alice = await person(), bob = await person();
    const a = await upload(alice), b = await upload(bob);
    expect(a).not.toBe(b);
    const rows = await db.select().from(wildcardFile).where(sql`${wildcardFile.id} in (${a}, ${b})`);
    expect(rows[0].contentFingerprint).not.toBe(rows[1].contentFingerprint);
    expect(rows.every((row) => row.contentFingerprint !== sha("hello") && !row.sealedMetadata.includes(sha("hello")))).toBe(true);
  });
  it("does not skip matching names with different bytes or trust a forged client digest", async () => {
    const user = await person(); const original = await upload(user);
    expect(await upload(user, "world")).not.toBe(original);
    const bad = await beginUpload(db, kek, user, "bad.txt", 5, undefined, randomUUID(), sha("wrong"), objects);
    await uploadPart(db, kek, user, bad.id, 0, Buffer.from("hello"), objects);
    await expect(completeUpload(db, kek, user, bad.id, objects)).rejects.toThrow("changed during upload");
    expect((await fileUsage(db, user)).count).toBe(2);
  });
  it("resolves concurrent first uploads to one stored file and releases the loser's objects and quota", async () => {
    const user = await person();
    const starts = await Promise.all([0, 1].map(() => beginUpload(db, kek, user, "note.txt", 5, undefined, randomUUID(), sha("hello"), objects)));
    await Promise.all(starts.map(({ id }) => uploadPart(db, kek, user, id, 0, Buffer.from("hello"), objects)));
    const result = await Promise.all(starts.map(({ id }) => completeUpload(db, kek, user, id, objects)));
    expect(result.filter((value) => value.skipped)).toHaveLength(1);
    expect(await fileUsage(db, user)).toEqual({ count: 1, bytes: 5 });
    const rows = await db.select().from(wildcardFile).where(eq(wildcardFile.userId, user));
    expect(rows[0].status).toBe("ready");
    const loser = starts.find((start) => start.id !== rows[0].id)!;
    expect(await deleteFile(db, user, loser.id, objects)).toBe(false);
  });
  it("indexes older encrypted documents in bounded checks and then uses only the database index", async () => {
    const user = await person();
    for (const value of ["aaaaa", "bbbbb", "ccccc", "ddddd"]) await storeFile(db, kek, user, "old.txt", Buffer.from(value), objects);
    await db.update(wildcardFile).set({ contentFingerprint: null }).where(eq(wildcardFile.userId, user));
    await expect(beginUpload(db, kek, user, "new.txt", 5, undefined, randomUUID(), sha("eeeee"), objects)).rejects.toMatchObject({ status: 202 });
    const fresh = await beginUpload(db, kek, user, "new.txt", 5, undefined, randomUUID(), sha("eeeee"), objects);
    expect(fresh.status).toBe("pending");
    const count = reads;
    const duplicate = await beginUpload(db, kek, user, "copy.txt", 5, undefined, randomUUID(), sha("ddddd"), objects);
    expect(duplicate.skipped).toBe(true); expect(reads).toBe(count);
  });
  it("allows a deleted document to be uploaded again and rejects malformed hashes", async () => {
    const user = await person(); const id = await upload(user);
    await deleteFile(db, user, id, objects);
    const fresh = await beginUpload(db, kek, user, "note.txt", 5, undefined, randomUUID(), sha("hello"), objects);
    expect(fresh.skipped).toBe(false);
    expect(() => beginUpload(db, kek, user, "note.txt", 5, undefined, undefined, "invalid")).toThrow("fingerprint");
  });
});


describe("legacy upload compatibility", () => {
  it("preserves the original document and skips a renamed legacy retry at full quota", async () => {
    const user = await person();
    await storeFile(db, kek, user, "original.txt", Buffer.from("hello"), objects);
    const original = await listFiles(db, kek, user);
    await db.execute(sql`insert into wildcard_file (id, user_id, sealed_metadata, object_key, size_bytes) select gen_random_uuid(), ${user}, 'test', gen_random_uuid()::text, 1 from generate_series(1, ${MAX_FILES - 1})`);
    const before = { reads, writes, usage: await fileUsage(db, user) };
    await storeFile(db, kek, user, "renamed.TXT", Buffer.from("hello"), objects);
    expect({ reads, writes }).toEqual({ reads: before.reads, writes: before.writes });
    expect(await fileUsage(db, user)).toEqual(before.usage);
    const [row] = await db.select().from(wildcardFile).where(eq(wildcardFile.id, original[0].id));
    expect(row.uploadedAt.toISOString()).toBe(original[0].uploadedAt);
    expect(row.sealedMetadata).not.toContain(sha("hello"));
  });

  it("keeps different contents and different owners separate", async () => {
    const alice = await person(), bob = await person();
    await storeFile(db, kek, alice, "note.txt", Buffer.from("hello"), objects);
    await storeFile(db, kek, alice, "note.txt", Buffer.from("world"), objects);
    await storeFile(db, kek, bob, "note.txt", Buffer.from("hello"), objects);
    expect(await fileUsage(db, alice)).toEqual({ count: 2, bytes: 10 });
    expect(await fileUsage(db, bob)).toEqual({ count: 1, bytes: 5 });
  });

  it("bounds historical indexing and requires a retry without reserving or writing", async () => {
    const user = await person();
    for (const value of ["aaaaa", "bbbbb", "ccccc", "ddddd"]) await storeFile(db, kek, user, "old.txt", Buffer.from(value), objects);
    await db.update(wildcardFile).set({ contentFingerprint: null }).where(eq(wildcardFile.userId, user));
    const before = { reads, writes };
    await expect(storeFile(db, kek, user, "new.txt", Buffer.from("eeeee"), objects)).rejects.toMatchObject({ status: 503 });
    expect(reads - before.reads).toBe(3);
    expect(writes).toBe(before.writes);
    expect(await fileUsage(db, user)).toEqual({ count: 4, bytes: 20 });
    await storeFile(db, kek, user, "copy.txt", Buffer.from("ddddd"), objects);
    expect(await fileUsage(db, user)).toEqual({ count: 4, bytes: 20 });
  });

  it.each(["legacy", "chunked"])("deduplicates simultaneous transports when %s publishes first", async (first) => {
    const user = await person();
    const start = await beginUpload(db, kek, user, "folder.txt", 5, "Folder/folder.txt", randomUUID(), sha("hello"), objects);
    await uploadPart(db, kek, user, start.id, 0, Buffer.from("hello"), objects);
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed = { ...objects, async put(key: string, bytes: Buffer) { await objects.put(key, bytes); entered(); await gate; } };
    const before = blobs.size;
    const loser = first === "legacy"
      ? completeUpload(db, kek, user, start.id, delayed)
      : storeFile(db, kek, user, "legacy.txt", Buffer.from("hello"), delayed);
    await paused;
    try {
      if (first === "legacy") await storeFile(db, kek, user, "legacy.txt", Buffer.from("hello"), objects);
      else await completeUpload(db, kek, user, start.id, objects);
    } finally { release(); }
    const result = await loser;
    if (first === "legacy") expect(result).toEqual({ skipped: true });
    expect(await fileUsage(db, user)).toEqual({ count: 1, bytes: 5 });
    expect(blobs.size).toBe(before); // One original remains; staging and losing objects are gone.
    const [file] = await listFiles(db, kek, user);
    expect(file.name).toBe(first === "legacy" ? "legacy.txt" : "folder.txt");
    expect(file.relativePath).toBe(first === "legacy" ? undefined : "Folder/folder.txt");
  });

  it("deduplicates concurrent legacy publications and cleans up the losing reservation", async () => {
    const user = await person();
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const before = blobs.size;
    const pending = storeFile(db, kek, user, "slow.txt", Buffer.from("hello"), {
      ...objects, async put(key, bytes) { await objects.put(key, bytes); entered(); await gate; },
    });
    await paused;
    try { await storeFile(db, kek, user, "fast.txt", Buffer.from("hello"), objects); }
    finally { release(); }
    await pending;
    expect(await fileUsage(db, user)).toEqual({ count: 1, bytes: 5 });
    expect(blobs.size).toBe(before + 1);
    expect((await listFiles(db, kek, user))[0].name).toBe("fast.txt");
  });
});
