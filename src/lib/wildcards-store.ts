import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { hmacFor, sealBinaryField, sealField, unsealBinaryField, unsealField, userKeysFor, type UserKeys } from "@/lib/crypto/user-keys";
import { asUser } from "@/lib/db/rls";
import { wildcardFile } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { fileSize, fileSizeError, MAX_FILES, MAX_STORAGE_BYTES, SINGLE_OBJECT_BYTES, UPLOAD_CHUNK_BYTES, type WildcardFile } from "./wildcards";
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
function metadata(keys: UserKeys, row: { id: string; sealedMetadata: string }) {
  return JSON.parse(unsealField(keys, row.sealedMetadata, location(row.id, "metadata"))) as { name: string; type: string; relativePath?: string; contentSha256?: string };
}

async function reserveQuota(tx: Db, userId: string, size: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
  const [usage] = await tx.select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(size_bytes), 0)::float8` })
    .from(wildcardFile).where(eq(wildcardFile.userId, userId));
  if (usage.count >= MAX_FILES) throw new FileInputError(`You have ${usage.count} documents; the limit is ${MAX_FILES} files. Delete a file before uploading another.`, 409);
  if (usage.bytes + size > MAX_STORAGE_BYTES) throw new FileInputError(`This file needs ${fileSize(size)}, but Documents has only ${fileSize(Math.max(0, MAX_STORAGE_BYTES - usage.bytes))} available (${fileSize(usage.bytes)} of ${fileSize(MAX_STORAGE_BYTES)} used). Delete files to free space, then try again.`, 409);
}

function digest(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function fingerprint(keys: UserKeys, sha256: string) { return hmacFor(keys, `document-content:v1:${sha256}`); }

// Existing encrypted files predate fingerprints. Index only same-size candidates,
// in bounded requests, so older documents also deduplicate without client downloads.
async function indexOlderFiles(db: Db, kek: Buffer, userId: string, size: number, sha256: string, objects: FileObjects) {
  const candidates = await asUser(db, userId, (tx) => tx.select({ id: wildcardFile.id }).from(wildcardFile)
    .where(and(eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"), eq(wildcardFile.sizeBytes, size), isNull(wildcardFile.contentFingerprint))).limit(4));
  for (const candidate of candidates.slice(0, 3)) {
    const file = await streamFile(db, kek, userId, candidate.id, objects);
    if (!file) continue;
    const hash = createHash("sha256");
    const reader = file.stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
      }
    } finally { reader.releaseLock(); }
    const sha = hash.digest("hex");
    await asUser(db, userId, async (tx) => {
      const keys = await userKeysFor(tx, kek, userId, new Date());
      await tx.update(wildcardFile).set({ contentFingerprint: fingerprint(keys, sha) })
        .where(and(eq(wildcardFile.id, candidate.id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready")));
    });
    if (sha === sha256) return false;
  }
  return candidates.length > 3;
}

export function beginUpload(db: Db, kek: Buffer, userId: string, name: string, size: number, relativePath?: string, requestId?: string, sha256?: string, objects?: FileObjects) {
  validateFileName(name);
  const pathError = relativePathError(name, relativePath);
  if (pathError) throw new FileInputError(pathError);
  if (!Number.isSafeInteger(size) || size < 0) throw new FileInputError("The file size could not be read. Choose the file again.");
  const sizeError = fileSizeError(size);
  if (sizeError) throw new FileInputError(sizeError, size === 0 ? 400 : 413);
  if (!/\.(pdf|txt|png|jpe?g|gif|webp)$/i.test(name)) throw new FileInputError("This file type is not supported. Choose a PDF, .txt, PNG, JPEG, GIF, or WebP file.", 415);
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new FileInputError("Invalid file fingerprint.");
  return (async () => {
    // Fast path uses the indexed verified fingerprint; no object reads.
    const duplicate = sha256 ? await asUser(db, userId, async (tx) => {
      const keys = await userKeysFor(tx, kek, userId, new Date());
      const [row] = await tx.select({ id: wildcardFile.id }).from(wildcardFile).where(and(eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"), eq(wildcardFile.sizeBytes, size), eq(wildcardFile.contentFingerprint, fingerprint(keys, sha256)))).limit(1);
      return row;
    }) : undefined;
    if (duplicate) return { id: duplicate.id, chunkBytes: UPLOAD_CHUNK_BYTES, status: "ready", parts: [] as string[], skipped: true };
    const moreToIndex = sha256 && objects ? await indexOlderFiles(db, kek, userId, size, sha256, objects) : false;
    return asUser(db, userId, async (tx) => {
    // The same opaque client ID reserves capacity only once, even when the
    // original response is lost. Serialize retries before looking up the row.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
    const keys = await userKeysFor(tx, kek, userId, new Date());
    if (sha256) {
      const [duplicate] = await tx.select({ id: wildcardFile.id }).from(wildcardFile).where(and(eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"), eq(wildcardFile.sizeBytes, size), eq(wildcardFile.contentFingerprint, fingerprint(keys, sha256)))).limit(1);
      if (duplicate) return { id: duplicate.id, chunkBytes: UPLOAD_CHUNK_BYTES, status: "ready", parts: [] as string[], skipped: true };
    }
    if (moreToIndex) throw new FileInputError("Checking existing documents for duplicates…", 202);
    if (requestId) {
      const [existing] = await tx.select().from(wildcardFile).where(and(eq(wildcardFile.id, requestId), eq(wildcardFile.userId, userId)));
      if (existing) {
        if (existing.sizeBytes !== size || metadata(keys, existing).name !== name || metadata(keys, existing).relativePath !== relativePath || (metadata(keys, existing).contentSha256 && metadata(keys, existing).contentSha256 !== sha256)) throw new FileInputError("This upload ID belongs to a different file.", 409);
        return { id: existing.id, chunkBytes: UPLOAD_CHUNK_BYTES, status: existing.status, parts: Object.keys(existing.uploadParts ?? {}) };
      }
    }
    await reserveQuota(tx, userId, size);
    const id = requestId ?? randomUUID();
    await tx.insert(wildcardFile).values({ id, userId, objectKey: `wildcards/${randomUUID()}`, sizeBytes: size,
      uploadChunkCount: Math.ceil(size / UPLOAD_CHUNK_BYTES), uploadParts: {}, status: "pending",
      sealedMetadata: sealField(keys, JSON.stringify({ name, type: "application/octet-stream", relativePath, contentSha256: sha256 }), location(id, "metadata")),
    });
    return { id, chunkBytes: UPLOAD_CHUNK_BYTES, status: "pending", parts: [] as string[], skipped: false };
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

export async function completeUpload(db: Db, kek: Buffer, userId: string, id: string, objects: FileObjects) {
  const upload = await asUser(db, userId, async (tx) => {
    const [stored] = await tx.select().from(wildcardFile).where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId))).for("update");
    // Completing a successful upload again is harmless after a lost response.
    if (stored?.status === "ready") return null;
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
  if (!upload) return { skipped: false };
  const { row, keys, partKeys } = upload;
  try {
    if (row.sizeBytes > SINGLE_OBJECT_BYTES) {
      // Authenticate and validate one piece at a time; never assemble GB-sized
      // plaintext/ciphertext buffers in a serverless function.
      const original = metadata(keys, row);
      const decoder = original.name.toLowerCase().endsWith(".txt") ? new TextDecoder("utf-8", { fatal: true }) : undefined;
      const hash = createHash("sha256");
      let type = "";
      for (let start = 0; start < partKeys.length; start += 8) {
        // Bounded parallel reads avoid hundreds of sequential storage trips.
        const batch = await Promise.all(partKeys.slice(start, start + 8).map(async (key, offset) =>
          unsealBinaryField(keys, await objects.get(key), location(id, `upload_part_${start + offset}`))));
        for (const [offset, bytes] of batch.entries()) {
          const index = start + offset;
          if (bytes.length !== Math.min(UPLOAD_CHUNK_BYTES, row.sizeBytes - index * UPLOAD_CHUNK_BYTES)) throw new Error("Stored upload piece has unexpected size");
          hash.update(bytes);
          if (decoder) {
            let text: string;
            try { text = decoder.decode(bytes, { stream: index < partKeys.length - 1 }); }
            catch { throw new FileInputError("This file’s contents do not match UTF-8 text."); }
            if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw new FileInputError("This file’s contents do not match UTF-8 text.");
            type = "text/plain; charset=utf-8";
          } else if (index === 0) type = validateFile(original.name, bytes).type;
        }
      }
      // The ordered manifest is sealed with the metadata so pieces cannot be
      // reordered, truncated, or substituted through a database edit.
      const sha256 = hash.digest("hex");
      if (original.contentSha256 && original.contentSha256 !== sha256) throw new FileInputError("The file changed during upload. Choose the file again.");
      const contentFingerprint = fingerprint(keys, sha256);
      const result = await asUser(db, userId, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
        const [duplicate] = await tx.select({ id: wildcardFile.id }).from(wildcardFile).where(and(eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"), eq(wildcardFile.contentFingerprint, contentFingerprint), ne(wildcardFile.id, id))).limit(1);
        if (duplicate) return { duplicate: true, updated: [] };
        const updated = await tx.update(wildcardFile).set({
          contentFingerprint, sealedMetadata: sealField(keys, JSON.stringify({ name: original.name, relativePath: original.relativePath, type, pieces: partKeys, sizeBytes: row.sizeBytes }), location(id, "metadata")),
          status: "ready", uploadedAt: new Date(),
        }).where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "finalizing"))).returning({ id: wildcardFile.id });
        return { duplicate: false, updated };
      });
      if (result.duplicate) { await deleteFile(db, userId, id, objects); return { skipped: true }; }
      if (!result.updated.length) throw new FileInputError("This upload was cancelled. Choose the file again.", 409);
      return { skipped: false };
    }
    const chunks: Buffer[] = [];
    for (const [index, key] of partKeys.entries()) {
      const bytes = unsealBinaryField(keys, await objects.get(key), location(id, `upload_part_${index}`));
      const expected = Math.min(UPLOAD_CHUNK_BYTES, row.sizeBytes - index * UPLOAD_CHUNK_BYTES);
      if (bytes.length !== expected) throw new Error("Stored upload piece has unexpected size");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks, row.sizeBytes);
    const original = metadata(keys, row);
    const sha256 = digest(bytes);
    if (original.contentSha256 && original.contentSha256 !== sha256) throw new FileInputError("The file changed during upload. Choose the file again.");
    const contentFingerprint = fingerprint(keys, sha256);
    const meta = { ...validateFile(original.name, bytes), relativePath: original.relativePath };
    await objects.put(row.objectKey, sealBinaryField(keys, bytes, location(id, "content")));
    const result = await asUser(db, userId, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const [duplicate] = await tx.select({ id: wildcardFile.id }).from(wildcardFile).where(and(eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"), eq(wildcardFile.contentFingerprint, contentFingerprint), ne(wildcardFile.id, id))).limit(1);
      if (duplicate) return { duplicate: true, updated: [] };
      const updated = await tx.update(wildcardFile).set({
        contentFingerprint, sealedMetadata: sealField(keys, JSON.stringify(meta), location(id, "metadata")), status: "ready", uploadedAt: new Date(),
      }).where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "finalizing"))).returning({ id: wildcardFile.id });
      return { duplicate: false, updated };
    });
    if (result.duplicate) { await deleteFile(db, userId, id, objects); return { skipped: true }; }
    const updated = result.updated;
    if (!updated.length) {
      await objects.delete(row.objectKey);
      throw new FileInputError("This upload was cancelled. Choose the file again.", 409);
    }
  } catch (error) {
    try { await deleteFile(db, userId, id, objects); } catch { /* Retain failed cleanup for owner retry. */ }
    throw error;
  }
  // A successful document stays available even if temporary-piece cleanup fails.
  try {
    for (const key of partKeys) await objects.delete(key);
    await asUser(db, userId, (tx) => tx.update(wildcardFile).set({ uploadParts: null, uploadChunkCount: null })
      .where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"))));
  } catch { /* The retained keys will be removed when the owner deletes the file. */ }
  return { skipped: false };
}

export async function storeFile(db: Db, kek: Buffer, userId: string, name: string, bytes: Buffer, objects: FileObjects): Promise<void> {
  const meta = validateFile(name, bytes);
  const id = randomUUID();
  const objectKey = `wildcards/${randomUUID()}`;
  const encrypted = await asUser(db, userId, async (tx) => {
    // Serialize quota checks for simultaneous uploads from this user's tabs.
    await reserveQuota(tx, userId, bytes.length);
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
    const updated = await asUser(db, userId, async (tx) => tx.update(wildcardFile).set({ status: "ready", uploadedAt: new Date(), contentFingerprint: fingerprint(await userKeysFor(tx, kek, userId, new Date()), digest(bytes)) })
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

export function listFiles(db: Db, kek: Buffer, userId: string, page = 1): Promise<WildcardFile[]> {
  return asUser(db, userId, async (tx) => {
    // Never select the large encrypted contents for the listing.
    const rows = await tx.select({ id: wildcardFile.id, sealedMetadata: wildcardFile.sealedMetadata,
      sizeBytes: wildcardFile.sizeBytes, uploadedAt: wildcardFile.uploadedAt, status: wildcardFile.status })
      .from(wildcardFile).where(eq(wildcardFile.userId, userId)).orderBy(desc(wildcardFile.uploadedAt), desc(wildcardFile.id)).limit(50).offset((page - 1) * 50);
    if (!rows.length) return [];
    const keys = await userKeysFor(tx, kek, userId, new Date());
    return rows.map((row) => {
      const { name, type, relativePath } = metadata(keys, row);
      return { id: row.id, name, type, relativePath, sizeBytes: row.sizeBytes, uploadedAt: row.uploadedAt.toISOString(), status: row.status };
    });
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

export async function streamFile(db: Db, kek: Buffer, userId: string, id: string, objects: FileObjects) {
  const stored = await asUser(db, userId, async (tx) => {
    const [row] = await tx.select().from(wildcardFile).where(and(eq(wildcardFile.id, id), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"))).limit(1);
    if (!row) return null;
    const keys = await userKeysFor(tx, kek, userId, new Date());
    return { meta: metadata(keys, row), keys, objectKey: row.objectKey };
  });
  if (!stored) return null;
  const meta = stored.meta as typeof stored.meta & { pieces?: string[]; sizeBytes?: number };
  async function* contents() {
    if (meta.pieces) {
      for (const [index, key] of meta.pieces.entries()) {
        const bytes = unsealBinaryField(stored!.keys, await objects.get(key), location(id, `upload_part_${index}`));
        if (bytes.length !== Math.min(UPLOAD_CHUNK_BYTES, meta.sizeBytes! - index * UPLOAD_CHUNK_BYTES)) throw new Error("Stored upload piece has unexpected size");
        yield bytes;
      }
    } else {
      yield unsealBinaryField(stored!.keys, await objects.get(stored!.objectKey), location(id, "content"));
    }
  }
  const iterator = contents();
  // Authenticate the first piece before sending response headers.
  let next = await iterator.next();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next.done) { controller.close(); return; }
      controller.enqueue(new Uint8Array(next.value));
      next = await iterator.next();
    },
    async cancel() { await iterator.return(undefined); },
  }, { highWaterMark: 0 });
  return { name: meta.name, type: meta.type, relativePath: meta.relativePath, stream };
}

// Buffered convenience for small-file callers and storage tests. HTTP downloads
// use streamFile so their memory usage stays independent of the file size.
export async function readFile(db: Db, kek: Buffer, userId: string, id: string, objects: FileObjects) {
  const file = await streamFile(db, kek, userId, id, objects);
  if (!file) return null;
  const bytes = Buffer.from(await new Response(file.stream).arrayBuffer());
  return { name: file.name, type: file.type, relativePath: file.relativePath, bytes };
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
