import { createLocalJWKSet, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createClientAssertion, jwksFor, parsePrivateJwk, publicJwks, type PrivateJwk } from "./client-assertion";

let privateJwk: PrivateJwk;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS384", { modulusLength: 2048, extractable: true });
  privateJwk = { ...(await exportJWK(privateKey)), kid: "key-1" };
});

describe("createClientAssertion", () => {
  it("signs an RS384 JWT Epic can verify with our public JWKS", async () => {
    const tokenEndpoint = "https://fhir.example.org/oauth2/token";
    const now = new Date();
    const jwt = await createClientAssertion({ clientId: "client-123", tokenEndpoint, privateJwk, now });

    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "RS384", kid: "key-1", typ: "JWT" });
    const { payload } = await jwtVerify(jwt, createLocalJWKSet(publicJwks(privateJwk)), {
      issuer: "client-123",
      audience: tokenEndpoint,
      currentDate: now,
    });
    expect(payload.sub).toBe("client-123");
    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.exp! - payload.iat!).toBe(240);
  });

  it("uses a new jti every time", async () => {
    const args = { clientId: "c", tokenEndpoint: "https://x.example/token", privateJwk };
    const a = await createClientAssertion(args);
    const b = await createClientAssertion(args);
    expect(decodeJwtId(a)).not.toBe(decodeJwtId(b));
  });
});

describe("publicJwks", () => {
  it("publishes only public parts, plus the retiring key when rotating", () => {
    const jwks = publicJwks(privateJwk, { kty: "RSA", n: "old-n", e: "AQAB", kid: "key-0" });
    expect(jwks.keys.map((k) => k.kid)).toEqual(["key-1", "key-0"]);
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(jwks.keys[0]).toMatchObject({ alg: "RS384", use: "sig" });
  });
});

describe("jwksFor", () => {
  it("publishes the key only at the JWK Set URL for the deployment's Epic environment", () => {
    expect(jwksFor("sandbox", { environment: "sandbox", current: privateJwk }).keys.map((k) => k.kid)).toEqual(["key-1"]);
    expect(jwksFor("production", { environment: "sandbox", current: privateJwk })).toEqual({ keys: [] });
    expect(jwksFor("production", { environment: "production", current: privateJwk }).keys.map((k) => k.kid)).toEqual(["key-1"]);
    expect(jwksFor("sandbox", { environment: "production", current: privateJwk })).toEqual({ keys: [] });
  });
});

describe("parsePrivateJwk", () => {
  it("requires a private RSA key with a kid", () => {
    expect(parsePrivateJwk(JSON.stringify(privateJwk)).kid).toBe("key-1");
    expect(() => parsePrivateJwk('{"kty":"RSA","n":"x","e":"AQAB","kid":"k"}')).toThrow(/private RSA JWK/);
  });
});

function decodeJwtId(jwt: string): string {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).jti;
}
