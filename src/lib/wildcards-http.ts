import "server-only";
import { UPLOAD_CHUNK_BYTES } from "./wildcards";
import { FileInputError } from "./wildcards-store";

export const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
export function fileError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: PRIVATE_HEADERS });
}
export function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin &&
    !["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "");
}
export function validFileId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// Read a bounded raw body rather than buffering arbitrary multipart requests.
// Each item in a multi-file selection is sent in its own request.
export async function readUpload(request: Request): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > UPLOAD_CHUNK_BYTES) throw new FileInputError("An upload piece exceeded the transfer limit. Refresh Documents and try again.");
  const reader = request.body?.getReader();
  if (!reader) throw new FileInputError("Choose a nonempty file.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > UPLOAD_CHUNK_BYTES) {
        await reader.cancel();
        throw new FileInputError("An upload piece exceeded the transfer limit. Refresh Documents and try again.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
