import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { wildcardFile } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { asUser } from "@/lib/db/rls";
import { deleteFile, listFiles, readFile, storeFile, validateFile } from "./wildcards-store";
import { MAX_FILE_BYTES, MAX_FILES, MAX_STORAGE_BYTES } from "./wildcards";

let db: Db;
const kek = randomBytes(32);
const alice = "files_alice";
const bob = "files_bob";
const blobs = new Map<string, Buffer>();
const objects = {
  async put(key: string, bytes: Buffer) { blobs.set(key, bytes); },
  async get(key: string) { const bytes = blobs.get(key); if (!bytes) throw new Error("Missing"); return bytes; },
  async delete(key: string) { blobs.delete(key); },
};
beforeAll(async () => {
  db = await createTestDb();
  await createTestUser(db, alice);
  await createTestUser(db, bob);
});

describe("private file storage", () => {
  it("encrypts names and contents, preserves originals, and scopes every operation to the owner", async () => {
    const bytes = Buffer.from("%PDF-1.7\nprivate health document");
    await storeFile(db, kek, alice, "Résumé.pdf", bytes, objects);
    const [listed] = await listFiles(db, kek, alice);
    expect(listed).toMatchObject({ name: "Résumé.pdf", type: "application/pdf", sizeBytes: bytes.length });
    expect(Date.parse(listed.uploadedAt)).toBeGreaterThan(0);
    const [raw] = await db.select().from(wildcardFile).where(eq(wildcardFile.id, listed.id));
    expect(raw.sealedMetadata).not.toContain("Résumé");
    expect(blobs.get(raw.objectKey)!.toString("utf8")).not.toContain("private health");
    expect(await readFile(db, kek, alice, listed.id, objects)).toMatchObject({ name: "Résumé.pdf", bytes });
    expect(await listFiles(db, kek, bob)).toEqual([]);
    expect(await readFile(db, kek, bob, listed.id, objects)).toBeNull();
    expect(await deleteFile(db, bob, listed.id, objects)).toBe(false);
    await expect(readFile(db, randomBytes(32), alice, listed.id, objects)).rejects.toThrow();
    expect(await deleteFile(db, alice, listed.id, objects)).toBe(true);
    expect(await readFile(db, kek, alice, listed.id, objects)).toBeNull();
  });

  it("binds encrypted bytes to their row", async () => {
    const owner = await createTestUser(db, "files_tamper");
    await storeFile(db, kek, owner, "a.txt", Buffer.from("one"), objects);
    await storeFile(db, kek, owner, "b.txt", Buffer.from("two"), objects);
    const rows = await db.select().from(wildcardFile).where(eq(wildcardFile.userId, owner));
    blobs.set(rows[1].objectKey, blobs.get(rows[0].objectKey)!);
    await expect(readFile(db, kek, owner, rows[1].id, objects)).rejects.toThrow();
  });

  it("cleans up a failed R2 upload and releases its quota", async () => {
    const owner = await createTestUser(db, "files_failed_put");
    await expect(storeFile(db, kek, owner, "a.txt", Buffer.from("one"), {
      ...objects, async put() { throw new Error("R2 unavailable"); },
    })).rejects.toThrow("R2 unavailable");
    expect(await listFiles(db, kek, owner)).toEqual([]);
  });

  it("keeps failed deletions visible and retryable, and refuses to read them", async () => {
    const owner = await createTestUser(db, "files_failed_delete");
    await storeFile(db, kek, owner, "a.txt", Buffer.from("one"), objects);
    const [file] = await listFiles(db, kek, owner);
    await expect(deleteFile(db, owner, file.id, {
      ...objects, async delete() { throw new Error("R2 unavailable"); },
    })).rejects.toThrow("R2 unavailable");
    expect((await listFiles(db, kek, owner))[0].status).toBe("deleting");
    expect(await readFile(db, kek, owner, file.id, objects)).toBeNull();
    expect(await deleteFile(db, owner, file.id, objects)).toBe(true);
    expect(await listFiles(db, kek, owner)).toEqual([]);
  });

  it("reserves quota before network calls, never exposes pending files, and cleans up cancelled uploads", async () => {
    const owner = await createTestUser(db, "files_pending");
    await expect(storeFile(db, kek, owner, "a.txt", Buffer.from("one"), {
      ...objects, async put(key, bytes) {
        const [file] = await listFiles(db, kek, owner);
        expect(file.status).toBe("pending");
        expect(await readFile(db, kek, owner, file.id, objects)).toBeNull();
        await deleteFile(db, owner, file.id, objects);
        await objects.put(key, bytes);
      },
    })).rejects.toThrow("cancelled");
    expect(await listFiles(db, kek, owner)).toEqual([]);
  });

  it("enforces quotas before inserting", async () => {
    const owner = await createTestUser(db, "files_quota");
    await db.execute(sql`insert into wildcard_file (id, user_id, sealed_metadata, object_key, size_bytes) select gen_random_uuid(), ${owner}, 'test', gen_random_uuid()::text, 1 from generate_series(1, ${MAX_FILES})`);
    await expect(storeFile(db, kek, owner, "extra.txt", Buffer.from("extra"), objects)).rejects.toThrow(`limit is ${MAX_FILES} files`);
    await db.delete(wildcardFile).where(eq(wildcardFile.userId, owner));
    await db.insert(wildcardFile).values(Array.from({ length: Math.ceil(MAX_STORAGE_BYTES / MAX_FILE_BYTES) }, (_, index) => ({ userId: owner, sealedMetadata: "test", objectKey: crypto.randomUUID(), sizeBytes: Math.min(MAX_FILE_BYTES, MAX_STORAGE_BYTES - index * MAX_FILE_BYTES) })));
    await expect(storeFile(db, kek, owner, "extra.txt", Buffer.from("extra"), objects)).rejects.toThrow("only 0.0 KB available");
  });

  it("uses fail-closed RLS, including when an application query omits its owner filter", async () => {
    await storeFile(db, kek, alice, "private.txt", Buffer.from("private"), objects);
    await db.execute(sql`create role files_app nologin`);
    await db.execute(sql`grant all on all tables in schema public to files_app`);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role files_app`);
      expect(await tx.select().from(wildcardFile)).toEqual([]);
      await asUser(tx as unknown as Db, bob, async (u) => {
        expect(await u.select().from(wildcardFile)).toEqual([]);
        expect(await u.delete(wildcardFile).where(eq(wildcardFile.userId, alice)).returning()).toEqual([]);
      });
    });
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`set local role files_app`);
      await asUser(tx as unknown as Db, bob, (u) => u.insert(wildcardFile).values({
        userId: alice, sealedMetadata: "test", objectKey: crypto.randomUUID(), sizeBytes: 1,
      }));
    })).rejects.toThrow();
  });
});

describe("file validation", () => {
  it.each([
    ["doc.pdf", Buffer.from("%PDF-1.7"), "application/pdf"],
    ["notes.TXT", Buffer.from("A plain text note ✓"), "text/plain; charset=utf-8"],
    ["photo.jpeg", Buffer.from([255, 216, 255, 224]), "image/jpeg"],
    ["image.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "image/png"],
    ["image.gif", Buffer.from("GIF89a"), "image/gif"],
    ["image.webp", Buffer.from("RIFF1234WEBP"), "image/webp"],
  ])("recognizes %s by extension and bytes", (name, bytes, type) => {
    expect(validateFile(name, bytes).type).toBe(type);
  });
  it.each([
    ["fake.pdf", Buffer.from("<script>alert(1)</script>")],
    ["image.svg", Buffer.from("<svg/>")], ["page.html", Buffer.from("<html/>")],
    ["../x.txt", Buffer.from("text")], ["x\r\n.txt", Buffer.from("text")],
    ["empty.txt", Buffer.alloc(0)], ["binary.txt", Buffer.from([0xff, 0x00])],
  ])("rejects %s", (name, bytes) => expect(() => validateFile(name, bytes)).toThrow());
});
