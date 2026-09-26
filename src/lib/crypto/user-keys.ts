import "server-only";
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { userDataKey } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { seal, unseal } from "./seal";

// Envelope encryption for stored health records. Each user has a random data key (DEK),
// sealed with the records key-encryption key (KEK, RECORDS_ENCRYPTION_KEY). Separate
// subkeys for encryption and HMAC are derived from the DEK. Deleting the user's key row
// (shredUserKeys) makes everything sealed under it unreadable, backups included.

export const KEK_VERSION = 1;

export type UserKeys = {
  userId: string;
  encryptionKey: Buffer;
  macKey: Buffer;
};

// Where a sealed value lives. It becomes the value's associated data, so a value
// copied to another row, column or user fails to decrypt.
export type FieldLocation = { table: string; field: string; rowId: string };

function dekAad(userId: string, kekVersion: number): string {
  return `user_data_key:${userId}:v${kekVersion}`;
}

function subkey(dek: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", dek, Buffer.alloc(0), `wildhearts records ${purpose} v1`, 32));
}

function keysFrom(userId: string, sealedDek: string, kek: Buffer, kekVersion: number): UserKeys {
  const dek = Buffer.from(unseal(sealedDek, kek, dekAad(userId, kekVersion)), "base64");
  return { userId, encryptionKey: subkey(dek, "encryption"), macKey: subkey(dek, "hmac") };
}

// The user's keys, creating their data key on first use. Safe to call concurrently:
// the first insert wins and every caller reads the stored row.
export async function userKeysFor(db: Db, kek: Buffer, userId: string, now: Date): Promise<UserKeys> {
  const sealedDek = seal(randomBytes(32).toString("base64"), kek, dekAad(userId, KEK_VERSION));
  await db.insert(userDataKey).values({ userId, sealedDek, kekVersion: KEK_VERSION, createdAt: now }).onConflictDoNothing();
  const [row] = await db.select().from(userDataKey).where(eq(userDataKey.userId, userId)).limit(1);
  if (!row) throw new Error("User data key missing after insert");
  return keysFrom(userId, row.sealedDek, kek, row.kekVersion);
}

// Permanently makes the user's stored records unreadable.
export async function shredUserKeys(db: Db, userId: string): Promise<void> {
  await db.delete(userDataKey).where(eq(userDataKey.userId, userId));
}

function aadFor(keys: UserKeys, location: FieldLocation): string {
  return `${location.table}:${location.field}:${keys.userId}:${location.rowId}`;
}

export function sealField(keys: UserKeys, plaintext: string, location: FieldLocation): string {
  return seal(plaintext, keys.encryptionKey, aadFor(keys, location));
}

export function unsealField(keys: UserKeys, sealed: string, location: FieldLocation): string {
  return unseal(sealed, keys.encryptionKey, aadFor(keys, location));
}

// JSON with object keys sorted at every level, so equal resources hash equally
// whatever order the server sent their fields in.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Keyed per user, so a hash can't be matched against guessed record contents.
export function hmacFor(keys: UserKeys, text: string): string {
  return createHmac("sha256", keys.macKey).update(text, "utf8").digest("base64url");
}

export function contentHmac(keys: UserKeys, resource: unknown): string {
  return hmacFor(keys, canonicalJson(resource));
}
