import "server-only";
import { keyFromBase64 } from "@/lib/crypto/seal";

// The portable chat service needs only this key, never the application's full environment
// (which includes Epic credentials and token keys). Deployment injects this one value into the
// trusted data gateway process.
export function chatRecordsKey(source: Record<string, string | undefined> = process.env): Buffer {
  const value = source.RECORDS_ENCRYPTION_KEY;
  if (!value) throw new Error("RECORDS_ENCRYPTION_KEY is required for encrypted chat storage");
  return keyFromBase64(value);
}
