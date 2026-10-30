import { describe, expect, it } from "vitest";
import { contentHmac, keysFrom, sealBinaryField, sealField, unsealBinaryField, unsealField } from "../src/crypto/fields";
import { keyFromBase64, seal, unseal } from "../src/crypto/seal";
import fixture from "./node-sealed-fixture.json";

// Records move from Neon to D1 as opaque sealed bytes, so values sealed by the Node app on
// Vercel must open here, in workerd under nodejs_compat, and the reverse.
describe("crypto on Workers", () => {
  const kek = keyFromBase64(fixture.kek);
  const keys = keysFrom(fixture.userId, fixture.sealedDek, kek, 1);

  it("opens values sealed by the Node implementation", () => {
    expect(unseal(fixture.sealedToken, keyFromBase64(fixture.tokenKey))).toBe("made-up-access-token");
    expect(unsealField(keys, fixture.sealedField, fixture.location)).toBe("Made-up lab summary");
    expect(unsealBinaryField(keys, Buffer.from(fixture.sealedBinary, "base64"), fixture.binaryLocation).toString()).toBe("made-up file bytes");
  });

  it("derives the same HMAC subkey", () => {
    expect(contentHmac(keys, { a: [1, { c: 3, d: 4 }], b: 2 })).toBe(fixture.hmac);
  });

  it("still binds sealed values to their row, field and user", () => {
    expect(() => unsealField(keys, fixture.sealedField, { ...fixture.location, rowId: "row-2" })).toThrow();
    expect(() => unsealField(keys, fixture.sealedField, { ...fixture.location, field: "sealed_resource" })).toThrow();
    expect(() => keysFrom("someone-else", fixture.sealedDek, kek, 1)).toThrow();
  });

  it("round-trips new values", () => {
    const location = { table: "fhir_resource", field: "sealed_resource", rowId: "row-9" };
    expect(unsealField(keys, sealField(keys, "made-up text", location), location)).toBe("made-up text");
    const bytes = Buffer.from([0, 1, 2, 250]);
    expect(unsealBinaryField(keys, sealBinaryField(keys, bytes, location), location)).toEqual(bytes);
    const key = keyFromBase64(fixture.tokenKey);
    expect(unseal(seal("x", key, "aad"), key, "aad")).toBe("x");
  });
});
