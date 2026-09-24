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

describe("keyFromBase64", () => {
  it("accepts 32 bytes and rejects anything else", () => {
    expect(keyFromBase64(randomBytes(32).toString("base64")).length).toBe(32);
    expect(() => keyFromBase64(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
