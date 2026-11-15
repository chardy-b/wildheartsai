import { createHash } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { fileSize, fileSizeError, MAX_FILES, MAX_STORAGE_BYTES, SINGLE_OBJECT_BYTES, UPLOAD_CHUNK_BYTES, type WildcardFile } from "@/lib/wildcards";
import { relativePathError } from "@/lib/wildcards-paths";
import { hmacFor, sealBinaryField, sealField, unsealBinaryField, unsealField, type UserKeys } from "../crypto/fields";
import { extractionJob, extractionRun, userDataKey, wildcardFile } from "../db/schema";
import type { FileObjects } from "./file-objects";
import type { UserScope } from "./scope";
import { userKeysFor } from "./user-keys";

// Documents (src/lib/wildcards-store.ts in the Next app): encrypted uploads in R2, metadata sealed
// in D1. Behaviour and messages are unchanged. Where Postgres took a per-person advisory lock or a
// row lock, D1 uses one guarded statement (docs/superpowers/specs/2026-10-30-d1-transaction-audit.md):
// - the quota check and the insert are one INSERT … SELECT that inserts nothing over the limits;
// - "no duplicate, then ready" is one UPDATE … WHERE NOT EXISTS;
// - an upload piece is recorded with json_set in one statement; claiming an upload for
//   finalizing is a compare-and-set update.
// Network work (R2) stays outside every statement.

export class FileInputError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

// Ignore browser-supplied MIME types. Only inert formats are served, with a restrictive CSP.
// SVG/HTML and other executable document formats are excluded.
export function validateFileName(name: string): void {
  if (!name || name.length > 255 || /[\x00-\x1f\x7f/\\‪-‮⁦-⁩]/u.test(name)) {
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
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) type = "text/plain; charset=utf-8";
    } catch {
      /* Invalid UTF-8 is not plain text. */
    }
  }
  if (!type) throw new FileInputError("This file’s contents do not match a supported format. Choose a PDF, UTF-8 .txt, PNG, JPEG, GIF, or WebP file with the correct extension.");
  return { name, type };
}

type Metadata = { name: string; type: string; relativePath?: string; contentSha256?: string; pieces?: string[]; sizeBytes?: number };
type Row = typeof wildcardFile.$inferSelect;

const location = (id: string, field: string) => ({ table: "wildcard_file", rowId: id, field });
const metadata = (keys: UserKeys, row: { id: string; sealedMetadata: string }) => JSON.parse(unsealField(keys, row.sealedMetadata, location(row.id, "metadata"))) as Metadata;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (keys: UserKeys, sha256: string) => hmacFor(keys, `document-content:v1:${sha256}`);
const ready = (id: string) => ({ id, chunkBytes: UPLOAD_CHUNK_BYTES, status: "ready", parts: [] as string[], skipped: true });

export async function fileUsage(scope: UserScope): Promise<{ count: number; bytes: number }> {
  const [usage] = await scope.selectFields(wildcardFile, { count: count(), bytes: sql<number>`coalesce(sum(${wildcardFile.sizeBytes}), 0)` });
  return { count: Number(usage.count), bytes: Number(usage.bytes) };
}

async function quotaError(scope: UserScope, size: number): Promise<FileInputError> {
  const usage = await fileUsage(scope);
  if (usage.count >= MAX_FILES) return new FileInputError(`You have ${usage.count} documents; the limit is ${MAX_FILES} files. Delete a file before uploading another.`, 409);
  return new FileInputError(
    `This file needs ${fileSize(size)}, but Documents has only ${fileSize(Math.max(0, MAX_STORAGE_BYTES - usage.bytes))} available (${fileSize(usage.bytes)} of ${fileSize(MAX_STORAGE_BYTES)} used). Delete files to free space, then try again.`,
    409,
  );
}

// Inserts a new file row only while the person stays within the file count and storage limits,
// in one statement (it replaces a quota check under an advisory lock). The guard reads the
// person's own data-key row, which exists once their keys are loaded. Returns whether it inserted.
async function insertWithinQuota(scope: UserScope, row: { id: string; objectKey: string; sizeBytes: number; sealedMetadata: string; status: "pending"; uploadChunkCount: number | null; uploadParts: Record<string, string> | null }, now: Date): Promise<boolean> {
  const mine = sql`${wildcardFile} where ${wildcardFile.userId} = ${scope.userId}`;
  // Every wildcard_file column, in table order (drizzle's INSERT … SELECT requires it).
  const values = scope.selectFields(
    userDataKey,
    {
      id: sql<string>`${row.id}`.as("id"),
      userId: sql<string>`${scope.userId}`.as("user_id"),
      sealedMetadata: sql<string>`${row.sealedMetadata}`.as("sealed_metadata"),
      contentFingerprint: sql<string | null>`null`.as("content_fingerprint"),
      objectKey: sql<string>`${row.objectKey}`.as("object_key"),
      status: sql<string>`${row.status}`.as("status"),
      uploadChunkCount: sql<number | null>`${row.uploadChunkCount}`.as("upload_chunk_count"),
      uploadParts: sql<string | null>`${row.uploadParts === null ? null : JSON.stringify(row.uploadParts)}`.as("upload_parts"),
      sizeBytes: sql<number>`${row.sizeBytes}`.as("size_bytes"),
      uploadedAt: sql<number>`${now.getTime()}`.as("uploaded_at"),
    },
    sql`(select count(*) from ${mine}) < ${MAX_FILES} and (select coalesce(sum(${wildcardFile.sizeBytes}), 0) from ${mine}) + ${row.sizeBytes} <= ${MAX_STORAGE_BYTES}`,
  );
  const [inserted] = await scope.batch([scope.insertSelect(wildcardFile, values as never).onConflictDoNothing().returning({ id: wildcardFile.id })]);
  return inserted.length > 0;
}

// Marks a finalizing file ready unless the person already has a ready copy of the same content,
// in one statement. Returns "ready", "duplicate", or "cancelled" (no longer finalizing).
async function markReady(scope: UserScope, id: string, contentFingerprint: string, sealedMetadata: string): Promise<"ready" | "duplicate" | "cancelled"> {
  const sameContent = and(eq(wildcardFile.userId, scope.userId), eq(wildcardFile.status, "ready"), eq(wildcardFile.contentFingerprint, contentFingerprint), ne(wildcardFile.id, id));
  const updated = await scope
    .update(wildcardFile, { contentFingerprint, sealedMetadata, status: "ready", uploadedAt: new Date() }, and(eq(wildcardFile.id, id), eq(wildcardFile.status, "finalizing"), sql`not exists (select 1 from ${wildcardFile} w2 where ${sql.raw("w2.user_id")} = ${scope.userId} and ${sql.raw("w2.status")} = 'ready' and ${sql.raw("w2.content_fingerprint")} = ${contentFingerprint} and ${sql.raw("w2.id")} != ${id})`))
    .returning({ id: wildcardFile.id });
  if (updated.length) return "ready";
  const [duplicate] = await scope.selectFields(wildcardFile, { id: wildcardFile.id }, sameContent).limit(1);
  return duplicate ? "duplicate" : "cancelled";
}

// Existing encrypted files predate fingerprints. Index only same-size candidates, in bounded
// requests, so older documents also deduplicate without client downloads.
async function indexOlderFiles(scope: UserScope, keys: UserKeys, size: number, sha256: string, objects: FileObjects): Promise<boolean> {
  const candidates = await scope
    .selectFields(wildcardFile, { id: wildcardFile.id }, and(eq(wildcardFile.status, "ready"), eq(wildcardFile.sizeBytes, size), isNull(wildcardFile.contentFingerprint)))
    .limit(4);
  for (const candidate of candidates.slice(0, 3)) {
    const file = await streamFile(scope, keys, candidate.id, objects);
    if (!file) continue;
    const hash = createHash("sha256");
    const reader = file.stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
      }
    } finally {
      reader.releaseLock();
    }
    const sha = hash.digest("hex");
    await scope.update(wildcardFile, { contentFingerprint: fingerprint(keys, sha) }, and(eq(wildcardFile.id, candidate.id), eq(wildcardFile.status, "ready")));
    if (sha === sha256) return false;
  }
  return candidates.length > 3;
}

export async function beginUpload(
  scope: UserScope,
  kek: Buffer,
  input: { name: string; size: number; relativePath?: string; requestId?: string; sha256?: string },
  objects?: FileObjects,
) {
  const { name, size, relativePath, requestId, sha256 } = input;
  validateFileName(name);
  const pathError = relativePathError(name, relativePath);
  if (pathError) throw new FileInputError(pathError);
  if (!Number.isSafeInteger(size) || size < 0) throw new FileInputError("The file size could not be read. Choose the file again.");
  const sizeError = fileSizeError(size);
  if (sizeError) throw new FileInputError(sizeError, size === 0 ? 400 : 413);
  if (!/\.(pdf|txt|png|jpe?g|gif|webp)$/i.test(name)) throw new FileInputError("This file type is not supported. Choose a PDF, .txt, PNG, JPEG, GIF, or WebP file.", 415);
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new FileInputError("Invalid file fingerprint.");

  const keys = await userKeysFor(scope, kek, new Date());
  const duplicateOf = async () =>
    sha256
      ? (await scope.selectFields(wildcardFile, { id: wildcardFile.id }, and(eq(wildcardFile.status, "ready"), eq(wildcardFile.sizeBytes, size), eq(wildcardFile.contentFingerprint, fingerprint(keys, sha256)))).limit(1))[0]
      : undefined;
  // Fast path uses the indexed verified fingerprint; no object reads.
  const duplicate = await duplicateOf();
  if (duplicate) return ready(duplicate.id);
  if (sha256 && objects && (await indexOlderFiles(scope, keys, size, sha256, objects))) throw new FileInputError("Checking existing documents for duplicates…", 202);
  const indexed = await duplicateOf();
  if (indexed) return ready(indexed.id);

  // The same opaque client ID reserves capacity only once, even when the original response is
  // lost: the insert skips an existing id, and the existing row is answered instead.
  const existing = async () => {
    if (!requestId) return undefined;
    const [row] = await scope.select(wildcardFile, eq(wildcardFile.id, requestId));
    if (!row) return undefined;
    const meta = metadata(keys, row);
    if (row.sizeBytes !== size || meta.name !== name || meta.relativePath !== relativePath || (meta.contentSha256 && meta.contentSha256 !== sha256)) {
      throw new FileInputError("This upload ID belongs to a different file.", 409);
    }
    return { id: row.id, chunkBytes: UPLOAD_CHUNK_BYTES, status: row.status, parts: Object.keys(row.uploadParts ?? {}) };
  };
  const before = await existing();
  if (before) return before;
  const id = requestId ?? crypto.randomUUID();
  const inserted = await insertWithinQuota(
    scope,
    {
      id,
      objectKey: `wildcards/${crypto.randomUUID()}`,
      sizeBytes: size,
      uploadChunkCount: Math.ceil(size / UPLOAD_CHUNK_BYTES),
      uploadParts: {},
      status: "pending",
      sealedMetadata: sealField(keys, JSON.stringify({ name, type: "application/octet-stream", relativePath, contentSha256: sha256 }), location(id, "metadata")),
    },
    new Date(),
  );
  if (inserted) return { id, chunkBytes: UPLOAD_CHUNK_BYTES, status: "pending", parts: [] as string[], skipped: false };
  // Not inserted: a simultaneous request with the same id won, or the limits were reached.
  const raced = await existing();
  if (raced) return raced;
  throw await quotaError(scope, size);
}

function requirePending(row: Row | undefined): Row {
  if (!row || !row.uploadChunkCount) throw new FileInputError("Upload not found. Choose the file again.", 404);
  if (row.status !== "pending") throw new FileInputError("This upload is no longer accepting data. Check your file list before trying again.", 409);
  if (Date.now() - row.uploadedAt.getTime() > 60 * 60 * 1000) throw new FileInputError("This upload expired. Delete the incomplete file and upload it again.", 410);
  return row;
}

export async function uploadPart(scope: UserScope, kek: Buffer, id: string, index: number, bytes: Buffer, objects: FileObjects): Promise<void> {
  const [stored] = await scope.select(wildcardFile, eq(wildcardFile.id, id)).limit(1);
  const row = requirePending(stored);
  if (!Number.isSafeInteger(index) || index < 0 || index >= row.uploadChunkCount!) throw new FileInputError("Invalid upload piece.");
  const expected = Math.min(UPLOAD_CHUNK_BYTES, row.sizeBytes - index * UPLOAD_CHUNK_BYTES);
  if (bytes.length !== expected) throw new FileInputError("An upload piece was incomplete. Try uploading the file again.");
  const keys = await userKeysFor(scope, kek, new Date());
  const encrypted = sealBinaryField(keys, bytes, location(id, `upload_part_${index}`));
  // Unique keys keep an in-flight retry from changing pieces already being finalized.
  const key = `wildcards-staging/${crypto.randomUUID()}`;
  let replaced: string | undefined;
  try {
    await objects.put(key, encrypted);
    // Records the piece in one statement (json_set, so simultaneous pieces never overwrite each
    // other), reading the key it replaces in the same atomic batch, for cleanup.
    const slot = `$."${index}"`;
    const [previous, updated] = await scope.batch([
      scope.selectFields(wildcardFile, { replaced: sql<string | null>`json_extract(${wildcardFile.uploadParts}, ${slot})` }, and(eq(wildcardFile.id, id), eq(wildcardFile.status, "pending"))),
      scope
        .update(wildcardFile, { uploadParts: sql`json_set(coalesce(${wildcardFile.uploadParts}, '{}'), ${slot}, ${key})`, uploadedAt: new Date() } as never, and(eq(wildcardFile.id, id), eq(wildcardFile.status, "pending")))
        .returning({ id: wildcardFile.id }),
    ]);
    if (!updated.length) throw new FileInputError("This upload is no longer accepting data. Check your file list before trying again.", 409);
    replaced = (previous[0]?.replaced as string | null) ?? undefined;
  } catch (error) {
    try {
      await objects.delete(key);
    } catch {
      /* Ciphertext only; the request may be retried. */
    }
    throw error;
  }
  if (replaced) {
    try {
      await objects.delete(replaced);
    } catch {
      /* Superseded ciphertext is never exposed as a file. */
    }
  }
}

export async function completeUpload(scope: UserScope, kek: Buffer, id: string, objects: FileObjects): Promise<{ skipped: boolean }> {
  const [stored] = await scope.select(wildcardFile, eq(wildcardFile.id, id)).limit(1);
  // Completing a successful upload again is harmless after a lost response.
  if (stored?.status === "ready") return { skipped: false };
  if (stored?.status === "finalizing" && Date.now() - stored.uploadedAt.getTime() < 5 * 60_000) throw new FileInputError("Your file is still being saved. Please wait.", 202);
  // A finalizer can't outlive its request. After a longer lease, another request can assemble
  // the frozen pieces after a crash.
  const row = requirePending(stored?.status === "finalizing" ? { ...stored, status: "pending", uploadedAt: new Date() } : stored);
  const partKeys = Array.from({ length: row.uploadChunkCount! }, (_, index) => row.uploadParts?.[String(index)]);
  if (partKeys.some((key) => !key)) throw new FileInputError("Some of this file has not arrived. Try uploading it again.", 409);
  // Claim it: only if nothing changed since it was read (compare-and-set on status and time).
  const claimed = await scope
    .update(wildcardFile, { status: "finalizing", uploadedAt: new Date() }, and(eq(wildcardFile.id, id), eq(wildcardFile.status, stored!.status), eq(wildcardFile.uploadedAt, stored!.uploadedAt)))
    .returning({ id: wildcardFile.id });
  if (!claimed.length) throw new FileInputError("Your file is still being saved. Please wait.", 202);
  const keys = await userKeysFor(scope, kek, new Date());
  const pieces = partKeys as string[];
  try {
    const original = metadata(keys, row);
    let outcome: "ready" | "duplicate" | "cancelled";
    if (row.sizeBytes > SINGLE_OBJECT_BYTES) {
      // Authenticate and validate one piece at a time; never assemble large buffers.
      const decoder = original.name.toLowerCase().endsWith(".txt") ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }) : undefined;
      const hash = createHash("sha256");
      let type = "";
      for (let start = 0; start < pieces.length; start += 8) {
        // Bounded parallel reads avoid hundreds of sequential storage trips.
        const batch = await Promise.all(pieces.slice(start, start + 8).map(async (key, offset) => unsealBinaryField(keys, await objects.get(key), location(id, `upload_part_${start + offset}`))));
        for (const [offset, bytes] of batch.entries()) {
          const index = start + offset;
          if (bytes.length !== Math.min(UPLOAD_CHUNK_BYTES, row.sizeBytes - index * UPLOAD_CHUNK_BYTES)) throw new Error("Stored upload piece has unexpected size");
          hash.update(bytes);
          if (decoder) {
            let text: string;
            try {
              text = decoder.decode(bytes, { stream: index < pieces.length - 1 });
            } catch {
              throw new FileInputError("This file’s contents do not match UTF-8 text.");
            }
            if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw new FileInputError("This file’s contents do not match UTF-8 text.");
            type = "text/plain; charset=utf-8";
          } else if (index === 0) type = validateFile(original.name, bytes).type;
        }
      }
      const sha256 = hash.digest("hex");
      if (original.contentSha256 && original.contentSha256 !== sha256) throw new FileInputError("The file changed during upload. Choose the file again.");
      // The ordered manifest is sealed with the metadata so pieces can't be reordered, truncated,
      // or substituted through a database edit.
      outcome = await markReady(scope, id, fingerprint(keys, sha256), sealField(keys, JSON.stringify({ name: original.name, relativePath: original.relativePath, type, pieces, sizeBytes: row.sizeBytes }), location(id, "metadata")));
    } else {
      const chunks: Buffer[] = [];
      for (const [index, key] of pieces.entries()) {
        const bytes = unsealBinaryField(keys, await objects.get(key), location(id, `upload_part_${index}`));
        if (bytes.length !== Math.min(UPLOAD_CHUNK_BYTES, row.sizeBytes - index * UPLOAD_CHUNK_BYTES)) throw new Error("Stored upload piece has unexpected size");
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks, row.sizeBytes);
      const sha256 = digest(bytes);
      if (original.contentSha256 && original.contentSha256 !== sha256) throw new FileInputError("The file changed during upload. Choose the file again.");
      const meta = { ...validateFile(original.name, bytes), relativePath: original.relativePath };
      await objects.put(row.objectKey, sealBinaryField(keys, bytes, location(id, "content")));
      outcome = await markReady(scope, id, fingerprint(keys, sha256), sealField(keys, JSON.stringify(meta), location(id, "metadata")));
      if (outcome === "cancelled") await objects.delete(row.objectKey);
    }
    if (outcome === "duplicate") {
      await deleteFile(scope, id, objects);
      return { skipped: true };
    }
    if (outcome === "cancelled") throw new FileInputError("This upload was cancelled. Choose the file again.", 409);
  } catch (error) {
    try {
      await deleteFile(scope, id, objects);
    } catch {
      /* Retain failed cleanup for the owner's retry. */
    }
    throw error;
  }
  // A small file now lives in one object, so its pieces can go. A large file is its pieces: its
  // sealed manifest and upload_parts both point at them, and deleting the file removes them.
  // Cleanup failures leave keys that the owner's delete removes later.
  if (row.sizeBytes <= SINGLE_OBJECT_BYTES) {
    try {
      for (const key of pieces) await objects.delete(key);
      await scope.update(wildcardFile, { uploadParts: null, uploadChunkCount: null }, and(eq(wildcardFile.id, id), eq(wildcardFile.status, "ready")));
    } catch {
      /* The retained keys are removed when the owner deletes the file. */
    }
  }
  return { skipped: false };
}

// One request with the whole file (small files).
export async function storeFile(scope: UserScope, kek: Buffer, name: string, bytes: Buffer, objects: FileObjects): Promise<void> {
  const meta = validateFile(name, bytes);
  const id = crypto.randomUUID();
  const objectKey = `wildcards/${crypto.randomUUID()}`;
  const keys = await userKeysFor(scope, kek, new Date());
  // Pending rows reserve quota and remain deletable if this request is interrupted.
  const inserted = await insertWithinQuota(scope, { id, objectKey, status: "pending", sizeBytes: bytes.length, uploadChunkCount: null, uploadParts: null, sealedMetadata: sealField(keys, JSON.stringify(meta), location(id, "metadata")) }, new Date());
  if (!inserted) throw await quotaError(scope, bytes.length);
  try {
    await objects.put(objectKey, sealBinaryField(keys, bytes, location(id, "content")));
    const updated = await scope
      .update(wildcardFile, { status: "ready", uploadedAt: new Date(), contentFingerprint: fingerprint(keys, digest(bytes)) }, and(eq(wildcardFile.id, id), eq(wildcardFile.status, "pending")))
      .returning({ id: wildcardFile.id });
    if (!updated.length) {
      await objects.delete(objectKey);
      throw new Error("Upload was cancelled");
    }
  } catch (error) {
    try {
      await deleteFile(scope, id, objects);
    } catch {
      /* Keep the row visible for the owner's cleanup or retry. */
    }
    throw error;
  }
}

export async function listFiles(scope: UserScope, kek: Buffer, page = 1): Promise<WildcardFile[]> {
  // Never select the large encrypted contents for the listing.
  const rows = await scope
    .selectFields(wildcardFile, { id: wildcardFile.id, sealedMetadata: wildcardFile.sealedMetadata, sizeBytes: wildcardFile.sizeBytes, uploadedAt: wildcardFile.uploadedAt, status: wildcardFile.status })
    .orderBy(desc(wildcardFile.uploadedAt), desc(wildcardFile.id))
    .limit(50)
    .offset((page - 1) * 50);
  if (!rows.length) return [];
  const keys = await userKeysFor(scope, kek, new Date());
  return rows.map((row) => {
    const { name, type, relativePath } = metadata(keys, row);
    return { id: row.id, name, type, relativePath, sizeBytes: row.sizeBytes, uploadedAt: row.uploadedAt.toISOString(), status: row.status };
  });
}

export async function fileMetadata(scope: UserScope, kek: Buffer, id: string): Promise<WildcardFile | null> {
  const [row] = await scope.selectFields(
    wildcardFile,
    { id: wildcardFile.id, sealedMetadata: wildcardFile.sealedMetadata, sizeBytes: wildcardFile.sizeBytes, uploadedAt: wildcardFile.uploadedAt, status: wildcardFile.status },
    eq(wildcardFile.id, id),
  );
  if (!row) return null;
  const keys = await userKeysFor(scope, kek, new Date());
  const { name, type, relativePath } = metadata(keys, row);
  return { id: row.id, name, type, relativePath, sizeBytes: row.sizeBytes, uploadedAt: row.uploadedAt.toISOString(), status: row.status };
}

// Reclaims abandoned reservations lazily, in bounded batches. The age is checked again when each
// row is claimed for deletion.
export async function cleanupExpiredUploads(scope: UserScope, objects: FileObjects): Promise<void> {
  const before = new Date(Date.now() - 60 * 60 * 1000);
  const expired = await scope.selectFields(wildcardFile, { id: wildcardFile.id }, and(inArray(wildcardFile.status, ["pending", "finalizing", "deleting"]), lt(wildcardFile.uploadedAt, before))).limit(25);
  for (const row of expired) await deleteFile(scope, row.id, objects, before);
}

export async function streamFile(scope: UserScope, keys: UserKeys, id: string, objects: FileObjects) {
  const [row] = await scope.select(wildcardFile, and(eq(wildcardFile.id, id), eq(wildcardFile.status, "ready"))).limit(1);
  if (!row) return null;
  const meta = metadata(keys, row);
  async function* contents() {
    if (meta.pieces) {
      for (const [index, key] of meta.pieces.entries()) {
        const bytes = unsealBinaryField(keys, await objects.get(key), location(id, `upload_part_${index}`));
        if (bytes.length !== Math.min(UPLOAD_CHUNK_BYTES, meta.sizeBytes! - index * UPLOAD_CHUNK_BYTES)) throw new Error("Stored upload piece has unexpected size");
        yield bytes;
      }
    } else {
      yield unsealBinaryField(keys, await objects.get(row.objectKey), location(id, "content"));
    }
  }
  const iterator = contents();
  // Authenticate the first piece before sending response headers.
  let next = await iterator.next();
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(next.value));
        next = await iterator.next();
      },
      async cancel() {
        await iterator.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
  return { name: meta.name, type: meta.type, relativePath: meta.relativePath, stream };
}

export async function deleteFile(scope: UserScope, id: string, objects: FileObjects, expiredBefore?: Date): Promise<boolean> {
  const [row] = await scope
    .update(wildcardFile, { status: "deleting" }, and(eq(wildcardFile.id, id), expiredBefore ? and(inArray(wildcardFile.status, ["pending", "finalizing", "deleting"]), lt(wildcardFile.uploadedAt, expiredBefore)) : undefined))
    .returning({ objectKey: wildcardFile.objectKey, uploadParts: wildcardFile.uploadParts, sealedMetadata: wildcardFile.sealedMetadata });
  if (!row) return false;
  await scope.update(
    extractionJob,
    { status: "cancelled", grantHash: null },
    and(inArray(extractionJob.status, ["waiting", "queued", "running"]), sql`${extractionJob.id} in (select ${extractionRun.id} from ${extractionRun} where ${extractionRun.fileId} = ${id} and ${extractionRun.userId} = ${scope.userId})`),
  );
  // Retain the row until deletion succeeds. Retrying a failed deletion is safe.
  await objects.delete(row.objectKey);
  for (const key of Object.values((row.uploadParts as Record<string, string> | null) ?? {})) await objects.delete(key);
  await scope.delete(wildcardFile, eq(wildcardFile.id, id));
  return true;
}
