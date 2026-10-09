import "server-only";
import { keyFromBase64 } from "@/lib/crypto/seal";

// Only the web-owned data boundary reads this key. The VPS relay and isolated worker
// never receive it or import the encrypted repository.
export function chatRecordsKey(source: Record<string, string | undefined> = process.env): Buffer {
  const value = source.RECORDS_ENCRYPTION_KEY;
  if (!value) throw new Error("RECORDS_ENCRYPTION_KEY is required for encrypted chat storage");
  return keyFromBase64(value);
}
