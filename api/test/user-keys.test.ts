import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sealField, unsealField } from "../src/crypto/fields";
import { forUser } from "../src/data/scope";
import { shredUserKeys, userKeysFor } from "../src/data/user-keys";
import { database } from "../src/db";
import { userDataKey } from "../src/db/schema";
import { clearPeople, seedPerson } from "./fixtures";

const db = database(env.DB);
const kek = Buffer.alloc(32, 5); // made-up test key
const location = { table: "fhir_resource", field: "sealed_summary", rowId: "row-1" };

beforeEach(async () => {
  await clearPeople(db);
  await seedPerson(db, "person-a");
  // The fixtures' placeholder key row isn't a real sealed key; start from no key.
  await forUser(db, "person-a").delete(userDataKey);
});

describe("userKeysFor on D1", () => {
  it("creates the key once, even when called concurrently", async () => {
    const scope = forUser(db, "person-a");
    const [first, second] = await Promise.all([userKeysFor(scope, kek, new Date()), userKeysFor(scope, kek, new Date())]);
    expect(first.encryptionKey.equals(second.encryptionKey)).toBe(true);
    const later = await userKeysFor(scope, kek, new Date());
    expect(unsealField(later, sealField(first, "made-up", location), location)).toBe("made-up");
  });

  it("makes sealed values unreadable once shredded", async () => {
    const scope = forUser(db, "person-a");
    const before = await userKeysFor(scope, kek, new Date());
    const sealed = sealField(before, "made-up", location);
    await shredUserKeys(scope);
    const after = await userKeysFor(scope, kek, new Date());
    expect(() => unsealField(after, sealed, location)).toThrow();
  });
});
