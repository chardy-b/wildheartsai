import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { hmacFor, sealBinaryField, sealField, unsealBinaryField, unsealField, userKeysFor, type UserKeys } from "@/lib/crypto/user-keys";
import { asUser } from "@/lib/db/rls";
import { wildcardFile } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { fileSize, fileSizeError, MAX_FILES, MAX_STORAGE_BYTES, UPLOAD_CHUNK_BYTES, type WildcardFile } from "./wildcards";
import type { FileObjects } from "./wildcards-r2";
import { relativePathError } from "./wildcards-paths";

export class FileInputError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

// Ignore browser-supplied MIME types. Only inert formats are served, with a
// restrictive CSP. SVG/HTML and other executable document formats are excluded.
export function validateFileName(name: string): void {
  if (!name || name.length > 255 || /[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw new FileInputError("Use a filename of 1–255 characters without paths or control characters.");
  }
}

export function validateFile(name: string, bytes: Buffer): { name: string; type: string } {
  validateFileName(name);
  const sizeError = fileSizeError(bytes.length);
  if (sizeError) throw new FileInputError(sizeError);
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
  if (!type) throw new FileInputError("This file’s contents do not match a supported format. Choose a PDF, UTF-8 .txt, PNG, JPEG, GIF, or WebP file with the correct extension.");
  return { name, type };
}

function location(id: string, field: string) { return { table: "wildcard_file", rowId: id, field }; }
type FileMetadata = { name: string; type: string; relativePath?: string; sha256?: string; expectedSha256?: string };
function metadata(keys: UserKeys, row: { id: string; sealedMetadata: string }) {
  return JSON.parse(unsealField(keys, row.sealedMetadata, location(row.id, "metadata"))) as FileMetadata;
}
function publicMetadata(meta: FileMetadata) { return { name: meta.name, type: meta.type, relativePath: meta.relativePath }; }
function hash(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function fingerprint(keys: UserKeys, sha256: string) { return hmacFor(keys, `wildcard_file.sha256:${sha256}`); }
async function lockFiles(tx: Db, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
}

async function findDuplicate(tx: Db, keys: UserKeys, userId: string, size: number | undefined, sha256: string) {
  const [row] = await tx.select({ id: wildcardFile.id }).from(wildcardFile)
    .where(and(eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"), eq(wildcardFile.contentHmac, fingerprint(keys, sha256)),
      size === undefined ? undefined : eq(wildcardFile.sizeBytes, size)))
    .orderBy(asc(wildcardFile.uploadedAt), asc(wildcardFile.id)).limit(1);
  return row;
}

// Older files acquire a verified hash lazily. Reads from R2 stay outside DB
// transactions; the conditional update cannot resurrect a deleted file or
// overwrite metadata changed since this snapshot. No old uploads are removed.
async function backfillHashes(db: Db, kek: Buffer, userId: string, size: number, sha256: string, objects: FileObjects) {
  const missing = and(eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"), eq(wildcardFile.sizeBytes, size), isNull(wildcardFile.contentHmac));
  const { keys, rows } = await asUser(db, userId, async (tx) => {
    const keys = await userKeysFor(tx, kek, userId, new Date());
    if (await findDuplicate(tx, keys, userId, size, sha256)) return { keys, rows: [] };
    const rows = await tx.select({ id: wildcardFile.id, sealedMetadata: wildcardFile.sealedMetadata, objectKey: wildcardFile.objectKey })
      .from(wildcardFile).where(missing).limit(10);
    return { keys, rows };
  });
  for (const row of rows) {
    const meta = metadata(keys, row);
    let bytes: Buffer;
    try { bytes = unsealBinaryField(keys, await objects.get(row.objectKey), location(row.id, "content")); }
    catch (error) {
      const stillReady = await asUser(db, userId, (tx) => tx.select({ id: wildcardFile.id }).from(wildcardFile)
        .where(and(eq(wildcardFile.id, row.id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"))));
      if (!stillReady.length) continue;
      throw error;
    }
    const actualHash = hash(bytes);
    const updated = await asUser(db, userId, (tx) => tx.update(wildcardFile).set({
      contentHmac: fingerprint(keys, actualHash),
      sealedMetadata: sealField(keys, JSON.stringify({ ...meta, sha256: actualHash }), location(row.id, "metadata")),
    }).where(and(eq(wildcardFile.id, row.id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"), eq(wildcardFile.sealedMetadata, row.sealedMetadata))).returning({ id: wildcardFile.id }));
    if (actualHash === sha256 && updated.length) return;
  }
  await asUser(db, userId, async (tx) => {
    if (await findDuplicate(tx, keys, userId, size, sha256)) return;
    if ((await tx.select({ id: wildcardFile.id }).from(wildcardFile).where(missing).limit(1)).length) {
      throw new FileInputError("Still checking older uploads for duplicates. Resume the queue to continue.", 503);
    }
  });
}

async function reserveQuota(tx: Db, userId: string, size: number): Promise<void> {
  const [usage] = await tx.select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(size_bytes), 0)::float8` })
    .from(wildcardFile).where(eq(wildcardFile.userId, userId));
  if (usage.count >= MAX_FILES) throw new FileInputError(`You have ${usage.count} documents; the limit is ${MAX_FILES} files. Delete a file before uploading another.`, 409);
  if (usage.bytes + size > MAX_STORAGE_BYTES) throw new FileInputError(`This file needs ${fileSize(size)}, but Documents has only ${fileSize(Math.max(0, MAX_STORAGE_BYTES - usage.bytes))} available (${fileSize(usage.bytes)} of ${fileSize(MAX_STORAGE_BYTES)} used). Delete files to free space, then try again.`, 409);
}

export function beginUpload(db: Db, kek: Buffer, userId: string, name: string, size: number, relativePath?: string, requestId?: string, sha256?: string, objects?: FileObjects) {
  validateFileName(name);
  const pathError = relativePathError(name, relativePath);
  if (pathError) throw new FileInputError(pathError);
  if (!Number.isSafeInteger(size) || size < 0) throw new FileInputError("The file size could not be read. Choose the file again.");
  const sizeError = fileSizeError(size);
  if (sizeError) throw new FileInputError(sizeError, size === 0 ? 400 : 413);
  if (!/\.(pdf|txt|png|jpe?g|gif|webp)$/i.test(name)) throw new FileInputError("This file type is not supported. Choose a PDF, .txt, PNG, JPEG, GIF, or WebP file.", 415);
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new FileInputError("The file hash could not be read. Choose the file again.");
  return (async () => {
    if (sha256 && objects) await backfillHashes(db, kek, userId, size, sha256, objects);
    return asUser(db, userId, async (tx) => {
      await lockFiles(tx, userId);
      const keys = await userKeysFor(tx, kek, userId, new Date());
      if (requestId) {
        const [existing] = await tx.select().from(wildcardFile).where(and(eq(wildcardFile.id, requestId), eq(wildcardFile.userId, userId)));
        if (existing) {
          const meta = metadata(keys, existing);
          if (existing.sizeBytes !== size || meta.name !== name || meta.relativePath !== relativePath ||
            (sha256 && (meta.sha256 ?? meta.expectedSha256) && (meta.sha256 ?? meta.expectedSha256) !== sha256)) throw new FileInputError("This upload ID belongs to a different file.", 409);
          return { id: existing.id, chunkBytes: UPLOAD_CHUNK_BYTES, status: existing.status, parts: Object.keys(existing.uploadParts ?? {}), duplicate: existing.status === "ready" };
        }
      }
      if (sha256) {
        const existing = await findDuplicate(tx, keys, userId, size, sha256);
        if (existing) return { id: existing.id, chunkBytes: UPLOAD_CHUNK_BYTES, status: "ready", parts: [] as string[], duplicate: true };
      }
      await reserveQuota(tx, userId, size);
      const id = requestId ?? randomUUID();
      await tx.insert(wildcardFile).values({ id, userId, objectKey: `wildcards/${randomUUID()}`, sizeBytes: size,
        uploadChunkCount: Math.ceil(size / UPLOAD_CHUNK_BYTES), uploadParts: {}, status: "pending",
        sealedMetadata: sealField(keys, JSON.stringify({ name, type: "application/octet-stream", relativePath, expectedSha256: sha256 }), location(id, "metadata")),
      });
      // A client hash is a lookup hint, never the hash of a newly stored file.
      return { id, chunkBytes: UPLOAD_CHUNK_BYTES, status: "pending", parts: [] as string[], duplicate: false };
    });
  })();
}

function requirePending(row: typeof wildcardFile.$inferSelect | undefined) {
  if (!row || !row.uploadChunkCount) throw new FileInputError("Upload not found. Choose the file again.", 404);
  if (row.status !== "pending") throw new FileInputError("This upload is no longer accepting data. Check your file list before trying again.", 409);
  if (Date.now() - row.uploadedAt.getTime() > 60 * 60 * 1000) throw new FileInputError("This upload expired. Delete the incomplete file and upload it again.", 410);
  return row;
}

export async function uploadPart(db: Db, kek: Buffer, userId: string, id: string, index: number, bytes: Buffer, objects: FileObjects) {
  const encrypted = await asUser(db, userId, async (tx) => {
    const [stored] = await tx.select().from(wildcardFile).where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId))).limit(1);
    const row = requirePending(stored);
    if (!Number.isSafeInteger(index) || index < 0 || index >= row.uploadChunkCount!) throw new FileInputError("Invalid upload piece.");
    const expected = Math.min(UPLOAD_CHUNK_BYTES, row.sizeBytes - index * UPLOAD_CHUNK_BYTES);
    if (bytes.length !== expected) throw new FileInputError("An upload piece was incomplete. Try uploading the file again.");
    const keys = await userKeysFor(tx, kek, userId, new Date());
    return sealBinaryField(keys, bytes, location(id, `upload_part_${index}`));
  });
  // Unique keys keep an in-flight retry from modifying pieces already being
  // finalized. The transaction below freezes the received set before assembly.
  const key = `wildcards-staging/${randomUUID()}`;
  let oldKey: string | undefined;
  try {
    await objects.put(key, encrypted);
    oldKey = await asUser(db, userId, async (tx) => {
      const [stored] = await tx.select().from(wildcardFile).where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId))).for("update");
      const row = requirePending(stored);
      const previous = row.uploadParts?.[String(index)];
      await tx.update(wildcardFile).set({ uploadParts: { ...row.uploadParts, [index]: key }, uploadedAt: new Date() }).where(eq(wildcardFile.id, id));
      return previous;
    });
  } catch (error) {
    try { await objects.delete(key); } catch { /* Ciphertext only; request may be retried. */ }
    throw error;
  }
  if (oldKey) { try { await objects.delete(oldKey); } catch { /* Superseded ciphertext is never exposed as a file. */ } }
}

export async function completeUpload(db: Db, kek: Buffer, userId: string, id: string, objects: FileObjects, sha256?: string) {
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new FileInputError("Invalid file hash.");
  const upload = await asUser(db, userId, async (tx) => {
    const [stored] = await tx.select().from(wildcardFile).where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId))).for("update");
    // Completing a successful upload again is harmless after a lost response.
    if (stored?.status === "ready") return { duplicate: false };
    // A duplicate's temporary row was removed. A verified, owner-scoped match
    // allows a retry after its completion response was lost, without receipts.
    if (!stored && sha256) {
      const keys = await userKeysFor(tx, kek, userId, new Date());
      if (await findDuplicate(tx, keys, userId, undefined, sha256)) return { duplicate: true };
    }
    if (stored?.status === "finalizing" && Date.now() - stored.uploadedAt.getTime() < 5 * 60_000) throw new FileInputError("Your file is still being saved. Please wait.", 202);
    // A finalizer cannot outlive its 120-second route deadline. After a longer
    // lease, another request can assemble the frozen pieces after a crash.
    const row = requirePending(stored?.status === "finalizing" ? { ...stored, status: "pending", uploadedAt: new Date() } : stored);
    const partKeys = Array.from({ length: row.uploadChunkCount! }, (_, index) => row.uploadParts?.[String(index)]);
    if (partKeys.some((key) => !key)) throw new FileInputError("Some of this file has not arrived. Try uploading it again.", 409);
    const keys = await userKeysFor(tx, kek, userId, new Date());
    await tx.update(wildcardFile).set({ status: "finalizing", uploadedAt: new Date() }).where(eq(wildcardFile.id, id));
    return { row, keys, partKeys: partKeys as string[] };
  });
  if ("duplicate" in upload) return { duplicate: upload.duplicate === true };
  const { row, keys, partKeys } = upload;
  try {
    const chunks: Buffer[] = [];
    for (const [index, key] of partKeys.entries()) {
      const bytes = unsealBinaryField(keys, await objects.get(key), location(id, `upload_part_${index}`));
      const expected = Math.min(UPLOAD_CHUNK_BYTES, row.sizeBytes - index * UPLOAD_CHUNK_BYTES);
      if (bytes.length !== expected) throw new Error("Stored upload piece has unexpected size");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks, row.sizeBytes);
    const original = metadata(keys, row);
    const meta = { ...validateFile(original.name, bytes), relativePath: original.relativePath, sha256: hash(bytes) };
    await backfillHashes(db, kek, userId, row.sizeBytes, meta.sha256, objects);
    await objects.put(row.objectKey, sealBinaryField(keys, bytes, location(id, "content")));
    const duplicate = await asUser(db, userId, async (tx) => {
      // Serialize publication so simultaneous uploads cannot both become ready.
      await lockFiles(tx, userId);
      const [current] = await tx.select({ status: wildcardFile.status }).from(wildcardFile)
        .where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId))).for("update");
      if (current?.status !== "finalizing") throw new FileInputError("This upload was cancelled. Choose the file again.", 409);
      if (await findDuplicate(tx, keys, userId, row.sizeBytes, meta.sha256)) return true;
      await tx.update(wildcardFile).set({
        sealedMetadata: sealField(keys, JSON.stringify(meta), location(id, "metadata")), contentHmac: fingerprint(keys, meta.sha256), status: "ready", uploadedAt: new Date(),
      }).where(eq(wildcardFile.id, id));
      return false;
    });
    if (duplicate) {
      await deleteFile(db, userId, id, objects);
      return { duplicate: true };
    }
  } catch (error) {
    if (error instanceof FileInputError && error.status === 503) {
      await asUser(db, userId, (tx) => tx.update(wildcardFile).set({ status: "pending", uploadedAt: new Date() })
        .where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "finalizing"))));
      throw error;
    }
    try { await deleteFile(db, userId, id, objects); } catch { /* Retain failed cleanup for owner retry. */ }
    throw error;
  }
  // A successful document stays available even if temporary-piece cleanup fails.
  try {
    for (const key of partKeys) await objects.delete(key);
    await asUser(db, userId, (tx) => tx.update(wildcardFile).set({ uploadParts: null, uploadChunkCount: null })
      .where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"))));
  } catch { /* The retained keys will be removed when the owner deletes the file. */ }
  return { duplicate: false };
}

export async function storeFile(db: Db, kek: Buffer, userId: string, name: string, bytes: Buffer, objects: FileObjects) {
  const meta = { ...validateFile(name, bytes), sha256: hash(bytes) };
  await backfillHashes(db, kek, userId, bytes.length, meta.sha256, objects);
  const id = randomUUID();
  const objectKey = `wildcards/${randomUUID()}`;
  const encrypted = await asUser(db, userId, async (tx) => {
    // Serialize quota checks for simultaneous uploads from this user's tabs.
    await lockFiles(tx, userId);
    const now = new Date();
    const keys = await userKeysFor(tx, kek, userId, now);
    if (await findDuplicate(tx, keys, userId, bytes.length, meta.sha256)) return null;
    await reserveQuota(tx, userId, bytes.length);
    await tx.insert(wildcardFile).values({
      id, userId, objectKey, status: "pending", sizeBytes: bytes.length, uploadedAt: now,
      sealedMetadata: sealField(keys, JSON.stringify(meta), location(id, "metadata")),
    });
    return sealBinaryField(keys, bytes, location(id, "content"));
  });
  if (!encrypted) return { duplicate: true };
  try {
    // Network operations always happen outside database transactions. Pending
    // rows reserve quota and remain deletable if this process is interrupted.
    await objects.put(objectKey, encrypted);
    const duplicate = await asUser(db, userId, async (tx) => {
      await lockFiles(tx, userId);
      const [current] = await tx.select({ status: wildcardFile.status }).from(wildcardFile)
        .where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId))).for("update");
      if (current?.status !== "pending") throw new Error("Upload was cancelled");
      const keys = await userKeysFor(tx, kek, userId, new Date());
      if (await findDuplicate(tx, keys, userId, bytes.length, meta.sha256)) return true;
      await tx.update(wildcardFile).set({ status: "ready", contentHmac: fingerprint(keys, meta.sha256), uploadedAt: new Date() }).where(eq(wildcardFile.id, id));
      return false;
    });
    if (duplicate) await deleteFile(db, userId, id, objects);
    return { duplicate };
  } catch (error) {
    try { await deleteFile(db, userId, id, objects); } catch { /* Keep row visible for the owner's cleanup/retry. */ }
    throw error;
  }
}

export function listFiles(db: Db, kek: Buffer, userId: string, page = 1): Promise<WildcardFile[]> {
  return asUser(db, userId, async (tx) => {
    // Never select the large encrypted contents for the listing.
    const rows = await tx.select({ id: wildcardFile.id, sealedMetadata: wildcardFile.sealedMetadata,
      sizeBytes: wildcardFile.sizeBytes, uploadedAt: wildcardFile.uploadedAt, status: wildcardFile.status })
      .from(wildcardFile).where(eq(wildcardFile.userId, userId)).orderBy(desc(wildcardFile.uploadedAt), desc(wildcardFile.id)).limit(50).offset((page - 1) * 50);
    if (!rows.length) return [];
    const keys = await userKeysFor(tx, kek, userId, new Date());
    return rows.map((row) => ({ id: row.id, ...publicMetadata(metadata(keys, row)), sizeBytes: row.sizeBytes, uploadedAt: row.uploadedAt.toISOString(), status: row.status }));
  });
}

export function fileUsage(db: Db, userId: string) {
  return asUser(db, userId, async (tx) => {
    const [usage] = await tx.select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(size_bytes), 0)::float8` })
      .from(wildcardFile).where(eq(wildcardFile.userId, userId));
    return usage;
  });
}

// Reclaim abandoned reservations lazily, in bounded batches. Network work is
// outside transactions; the age predicate is checked again when claiming rows.
export async function cleanupExpiredUploads(db: Db, userId: string, objects: FileObjects) {
  const before = new Date(Date.now() - 60 * 60 * 1000);
  const expired = await asUser(db, userId, (tx) => tx.select({ id: wildcardFile.id }).from(wildcardFile)
    .where(and(eq(wildcardFile.userId, userId), inArray(wildcardFile.status, ["pending", "finalizing", "deleting"]), lt(wildcardFile.uploadedAt, before))).limit(25));
  for (const row of expired) await deleteFile(db, userId, row.id, objects, before);
}

export async function readFile(db: Db, kek: Buffer, userId: string, id: string, objects: FileObjects) {
  const stored = await asUser(db, userId, async (tx) => {
    const [row] = await tx.select().from(wildcardFile).where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"))).limit(1);
    if (!row) return null;
    const keys = await userKeysFor(tx, kek, userId, new Date());
    return { meta: publicMetadata(metadata(keys, row)), keys, objectKey: row.objectKey };
  });
  if (!stored) return null;
  const encrypted = await objects.get(stored.objectKey);
  return { ...stored.meta, bytes: unsealBinaryField(stored.keys, encrypted, location(id, "content")) };
}

export async function deleteFile(db: Db, userId: string, id: string, objects: FileObjects, expiredBefore?: Date) {
  const [row] = await asUser(db, userId, (tx) => tx.update(wildcardFile).set({ status: "deleting" })
    .where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId), expiredBefore ? and(inArray(wildcardFile.status, ["pending", "finalizing", "deleting"]), lt(wildcardFile.uploadedAt, expiredBefore)) : undefined)).returning({ objectKey: wildcardFile.objectKey, uploadParts: wildcardFile.uploadParts }));
  if (!row) return false;
  // Retain the row until deletion succeeds. Retrying a failed deletion is safe.
  await objects.delete(row.objectKey);
  for (const key of Object.values(row.uploadParts ?? {})) await objects.delete(key);
  await asUser(db, userId, (tx) => tx.delete(wildcardFile).where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId))));
  return true;
}
