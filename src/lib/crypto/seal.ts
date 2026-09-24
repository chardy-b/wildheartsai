import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Format: v1.<iv>.<ciphertext>.<auth tag>, each part base64url.
const PREFIX = "v1";

export function keyFromBase64(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes, base64-encoded");
  return key;
}

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function unseal(sealed: string, key: Buffer): string {
  const [prefix, iv, body, tag] = sealed.split(".");
  if (prefix !== PREFIX || iv === undefined || body === undefined || tag === undefined) {
    throw new Error("Unrecognized sealed value");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
