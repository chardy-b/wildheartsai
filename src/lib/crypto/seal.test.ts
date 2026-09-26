import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyFromBase64, seal, unseal } from "./seal";

const key = randomBytes(32);

describe("seal", () => {
  it("round-trips text", () => {
    expect(unseal(seal("access-token-123", key), key)).toBe("access-token-123");
  });

  it("uses a fresh IV every time", () => {
    expect(seal("same", key)).not.toBe(seal("same", key));
  });

  it("does not contain the plaintext", () => {
    expect(seal("patient-abc", key)).not.toContain("patient-abc");
  });

  it("rejects tampered ciphertext", () => {
    const [prefix, iv, body, tag] = seal("secret", key).split(".");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 1;
    expect(() => unseal([prefix, iv, flipped.toString("base64url"), tag].join("."), key)).toThrow();
  });

  it("rejects the wrong key", () => {
    expect(() => unseal(seal("secret", key), randomBytes(32))).toThrow();
  });
});

describe("seal with associated data (v2)", () => {
  it("round-trips with the same associated data", () => {
    const sealed = seal("lab result", key, "fhir_resource:resource:user-1:row-1");
    expect(sealed.startsWith("v2.")).toBe(true);
    expect(unseal(sealed, key, "fhir_resource:resource:user-1:row-1")).toBe("lab result");
  });

  it("fails with different associated data", () => {
    const sealed = seal("lab result", key, "fhir_resource:resource:user-1:row-1");
    expect(() => unseal(sealed, key, "fhir_resource:resource:user-1:row-2")).toThrow();
    expect(() => unseal(sealed, key, "fhir_resource:summary:user-1:row-1")).toThrow();
  });

  it("will not open a bound value without its associated data", () => {
    expect(() => unseal(seal("lab result", key, "a"), key)).toThrow(/binding/);
  });

  it("will not accept an unbound value where a bound one is expected", () => {
    expect(() => unseal(seal("lab result", key), key, "a")).toThrow(/binding/);
  });

  it("keeps v1 values readable", () => {
    const sealed = seal("token", key);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(unseal(sealed, key)).toBe("token");
  });
});

describe("keyFromBase64", () => {
  it("accepts 32 bytes and rejects anything else", () => {
    expect(keyFromBase64(randomBytes(32).toString("base64")).length).toBe(32);
    expect(() => keyFromBase64(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
