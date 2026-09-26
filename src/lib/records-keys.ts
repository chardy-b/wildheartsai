import "server-only";
import { keyFromBase64 } from "@/lib/crypto/seal";
import { env } from "@/lib/env";

// The key-encryption key for stored health records. Separate from tokenKey() so one
// leaked key doesn't expose both tokens and records.
export function recordsKey(): Buffer {
  const value = env().RECORDS_ENCRYPTION_KEY;
  if (!value) throw new Error("RECORDS_ENCRYPTION_KEY is not set");
  return keyFromBase64(value);
}
