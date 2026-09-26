import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { userDataKey } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createTestDb, createTestUser } from "@/test/db";
import { canonicalJson, contentHmac, sealField, shredUserKeys, unsealField, userKeysFor } from "./user-keys";

const kek = randomBytes(32);
const now = new Date("2026-09-26T10:00:00Z");
const here = { table: "fhir_resource", field: "resource", rowId: "row-1" };
let db: Db;
let userId: string;

// One database per file (each takes seconds to migrate); each test gets its own user.
let nextUser = 0;
const newUser = () => createTestUser(db, `user_${++nextUser}`);

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  userId = await newUser();
});

describe("user data keys", () => {
  it("creates one key per user and returns the same keys afterwards", async () => {
    const first = await userKeysFor(db, kek, userId, now);
    const second = await userKeysFor(db, kek, userId, now);
    expect(second.encryptionKey.equals(first.encryptionKey)).toBe(true);
    expect(await db.select().from(userDataKey).where(eq(userDataKey.userId, userId))).toHaveLength(1);
  });

  it("agrees on one key when first calls race", async () => {
    const results = await Promise.all([1, 2, 3].map(() => userKeysFor(db, kek, userId, now)));
    for (const keys of results) expect(keys.encryptionKey.equals(results[0].encryptionKey)).toBe(true);
  });

  it("gives each user a different key", async () => {
    const other = await newUser();
    const a = await userKeysFor(db, kek, userId, now);
    const b = await userKeysFor(db, kek, other, now);
    expect(a.encryptionKey.equals(b.encryptionKey)).toBe(false);
  });

  it("stores the data key sealed, and needs the right key-encryption key", async () => {
    const keys = await userKeysFor(db, kek, userId, now);
    const [row] = await db.select().from(userDataKey).where(eq(userDataKey.userId, userId));
    expect(row.sealedDek.startsWith("v2.")).toBe(true);
    expect(row.sealedDek).not.toContain(keys.encryptionKey.toString("base64"));
    await expect(userKeysFor(db, randomBytes(32), userId, now)).rejects.toThrow();
  });

  it("uses different subkeys for encryption and HMAC", async () => {
    const keys = await userKeysFor(db, kek, userId, now);
    expect(keys.encryptionKey.equals(keys.macKey)).toBe(false);
  });
});

describe("sealed fields", () => {
  it("round-trip at the same location", async () => {
    const keys = await userKeysFor(db, kek, userId, now);
    expect(unsealField(keys, sealField(keys, '{"resourceType":"Observation"}', here), here)).toBe('{"resourceType":"Observation"}');
  });

  it("don't open on another row, column or user", async () => {
    const keys = await userKeysFor(db, kek, userId, now);
    const sealed = sealField(keys, "secret", here);
    expect(() => unsealField(keys, sealed, { ...here, rowId: "row-2" })).toThrow();
    expect(() => unsealField(keys, sealed, { ...here, field: "summary" })).toThrow();
    expect(() => unsealField({ ...keys, userId: "someone-else" }, sealed, here)).toThrow();
  });

  it("are unreadable once the user's key is shredded", async () => {
    const keys = await userKeysFor(db, kek, userId, now);
    const sealed = sealField(keys, "secret", here);
    await shredUserKeys(db, userId);
    const fresh = await userKeysFor(db, kek, userId, now);
    expect(() => unsealField(fresh, sealed, here)).toThrow();
  });
});

describe("content HMAC", () => {
  it("ignores key order and undefined fields", async () => {
    const keys = await userKeysFor(db, kek, userId, now);
    const a = { resourceType: "Observation", id: "1", code: { text: "A1c", coding: [{ code: "4548-4", system: "loinc" }] } };
    const b = { code: { coding: [{ system: "loinc", code: "4548-4" }], text: "A1c" }, id: "1", resourceType: "Observation", note: undefined };
    expect(contentHmac(keys, a)).toBe(contentHmac(keys, b));
  });

  it("changes when content changes, and differs between users", async () => {
    const keys = await userKeysFor(db, kek, userId, now);
    const other = await userKeysFor(db, kek, await newUser(), now);
    const resource = { resourceType: "Observation", id: "1", valueQuantity: { value: 5.4 } };
    expect(contentHmac(keys, resource)).not.toBe(contentHmac(keys, { ...resource, valueQuantity: { value: 5.5 } }));
    expect(contentHmac(keys, resource)).not.toBe(contentHmac(other, resource));
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
