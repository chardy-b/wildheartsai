import "server-only";
import { keyFromBase64 } from "@/lib/crypto/seal";
import { env } from "@/lib/env";

// The key-encryption key for stored health records. Separate from tokenKey() so one
// leaked key doesn't expose both tokens and records.
export function recordsKey(): Buffer {
  return keyFromBase64(env().RECORDS_ENCRYPTION_KEY);
}
