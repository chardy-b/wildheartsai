import { describe, expect, it } from "vitest";
import { challengeFor, createPkcePair, createState, safeEqual } from "./pkce";

describe("PKCE", () => {
  it("matches the RFC 7636 S256 test vector", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates a 43-character verifier and its challenge", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(challengeFor(verifier));
  });

  it("creates unpredictable state values", () => {
    const a = createState();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(createState());
  });

  it("compares strings without short-circuiting on length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
