import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Format: <version>.<iv>.<ciphertext>.<auth tag>, each part base64url.
// v1: no associated data. v2: authenticated associated data (aad), which binds the
// value to where it is stored, so it can't be copied to another row or user.
const V1 = "v1";
const V2 = "v2";

export function keyFromBase64(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes, base64-encoded");
  return key;
}

export function seal(plaintext: string, key: Buffer, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [aad === undefined ? V1 : V2, iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function unseal(sealed: string, key: Buffer, aad?: string): string {
  const [prefix, iv, body, tag] = sealed.split(".");
  if ((prefix !== V1 && prefix !== V2) || iv === undefined || body === undefined || tag === undefined) {
    throw new Error("Unrecognized sealed value");
  }
  // A bound caller never accepts an unbound value, and a bound value never opens without its aad.
  if ((prefix === V2) !== (aad !== undefined)) throw new Error("Sealed value binding mismatch");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
