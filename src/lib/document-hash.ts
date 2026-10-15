import { sha256 } from "@noble/hashes/sha2.js";
import { UPLOAD_CHUNK_BYTES } from "./wildcards";

// Standard SHA-256, independent of chunk boundaries, without a whole-file read.
export async function documentHash(file: Blob, signal?: AbortSignal): Promise<string> {
  const hash = sha256.create();
  try {
    for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
      signal?.throwIfAborted();
      hash.update(new Uint8Array(await file.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer()));
    }
    signal?.throwIfAborted();
    return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally { hash.destroy(); }
}
