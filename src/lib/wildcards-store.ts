import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { sealBinaryField, sealField, unsealBinaryField, unsealField, userKeysFor, type UserKeys } from "@/lib/crypto/user-keys";
import { asUser } from "@/lib/db/rls";
import { wildcardFile } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { MAX_FILE_BYTES, MAX_FILES, MAX_STORAGE_BYTES, type WildcardFile } from "./wildcards";
import type { FileObjects } from "./wildcards-r2";

export class FileInputError extends Error {}

// Ignore browser-supplied MIME types. Only inert formats are served, with a
// restrictive CSP. SVG/HTML and other executable document formats are excluded.
export function validateFile(name: string, bytes: Buffer): { name: string; type: string } {
  if (!name || name.length > 255 || /[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw new FileInputError("Use a filename of 1–255 characters without paths or control characters.");
  }
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new FileInputError("Files must be nonempty and no larger than 3 MB.");
  const ext = name.split(".").pop()?.toLowerCase();
  let type: string | undefined;
  if (ext === "pdf" && bytes.subarray(0, 5).toString("ascii") === "%PDF-") type = "application/pdf";
  if (ext === "png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) type = "image/png";
  if ((ext === "jpg" || ext === "jpeg") && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) type = "image/jpeg";
  if (ext === "gif" && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) type = "image/gif";
  if (ext === "webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") type = "image/webp";
  if (ext === "txt") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) type = "text/plain; charset=utf-8";
    } catch { /* Invalid UTF-8 is not plain text. */ }
  }
  if (!type) throw new FileInputError("Choose a valid PDF, UTF-8 text, PNG, JPEG, GIF, or WebP file with a matching extension.");
  return { name, type };
}

function location(id: string, field: string) { return { table: "wildcard_file", rowId: id, field }; }
function metadata(keys: UserKeys, row: { id: string; sealedMetadata: string }) {
  return JSON.parse(unsealField(keys, row.sealedMetadata, location(row.id, "metadata"))) as { name: string; type: string };
}

export async function storeFile(db: Db, kek: Buffer, userId: string, name: string, bytes: Buffer, objects: FileObjects): Promise<void> {
  const meta = validateFile(name, bytes);
  const id = randomUUID();
  const objectKey = `wildcards/${randomUUID()}`;
  const encrypted = await asUser(db, userId, async (tx) => {
    // Serialize quota checks for simultaneous uploads from this user's tabs.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
    const [usage] = await tx.select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(size_bytes), 0)::int` })
      .from(wildcardFile).where(eq(wildcardFile.userId, userId));
    if (usage.count >= MAX_FILES || usage.bytes + bytes.length > MAX_STORAGE_BYTES) {
      throw new FileInputError("Your Documents storage is full (100 MB or 200 files). Delete a file before uploading more.");
    }
    const now = new Date();
    const keys = await userKeysFor(tx, kek, userId, now);
    await tx.insert(wildcardFile).values({
      id, userId, objectKey, status: "pending", sizeBytes: bytes.length, uploadedAt: now,
      sealedMetadata: sealField(keys, JSON.stringify(meta), location(id, "metadata")),
    });
    return sealBinaryField(keys, bytes, location(id, "content"));
  });
  try {
    // Network operations always happen outside database transactions. Pending
    // rows reserve quota and remain deletable if this process is interrupted.
    await objects.put(objectKey, encrypted);
    const updated = await asUser(db, userId, (tx) => tx.update(wildcardFile).set({ status: "ready", uploadedAt: new Date() })
      .where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "pending"))).returning({ id: wildcardFile.id }));
    if (!updated.length) {
      await objects.delete(objectKey);
      throw new Error("Upload was cancelled");
    }
  } catch (error) {
    try { await deleteFile(db, userId, id, objects); } catch { /* Keep row visible for the owner's cleanup/retry. */ }
    throw error;
  }
}

export function listFiles(db: Db, kek: Buffer, userId: string): Promise<WildcardFile[]> {
  return asUser(db, userId, async (tx) => {
    // Never select the large encrypted contents for the listing.
    const rows = await tx.select({ id: wildcardFile.id, sealedMetadata: wildcardFile.sealedMetadata,
      sizeBytes: wildcardFile.sizeBytes, uploadedAt: wildcardFile.uploadedAt, status: wildcardFile.status })
      .from(wildcardFile).where(eq(wildcardFile.userId, userId)).orderBy(desc(wildcardFile.uploadedAt), desc(wildcardFile.id));
    if (!rows.length) return [];
    const keys = await userKeysFor(tx, kek, userId, new Date());
    return rows.map((row) => ({ id: row.id, ...metadata(keys, row), sizeBytes: row.sizeBytes, uploadedAt: row.uploadedAt.toISOString(), status: row.status }));
  });
}

export async function readFile(db: Db, kek: Buffer, userId: string, id: string, objects: FileObjects) {
  const stored = await asUser(db, userId, async (tx) => {
    const [row] = await tx.select().from(wildcardFile).where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"))).limit(1);
    if (!row) return null;
    const keys = await userKeysFor(tx, kek, userId, new Date());
    return { meta: metadata(keys, row), keys, objectKey: row.objectKey };
  });
  if (!stored) return null;
  const encrypted = await objects.get(stored.objectKey);
  return { ...stored.meta, bytes: unsealBinaryField(stored.keys, encrypted, location(id, "content")) };
}

export async function deleteFile(db: Db, userId: string, id: string, objects: FileObjects) {
  const [row] = await asUser(db, userId, (tx) => tx.update(wildcardFile).set({ status: "deleting" })
    .where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId))).returning({ objectKey: wildcardFile.objectKey }));
  if (!row) return false;
  // Retain the row until deletion succeeds. Retrying a failed deletion is safe.
  await objects.delete(row.objectKey);
  await asUser(db, userId, (tx) => tx.delete(wildcardFile).where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId))));
  return true;
}
