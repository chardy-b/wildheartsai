import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { credentialsFor, epicEnvironmentOf, publishedJwks } from "./credentials";
import { EPIC_SANDBOX } from "./directory";

const settings = {
  EPIC_CLIENT_ID: "nonprod-client",
  EPIC_PRIVATE_JWK: '{"kid":"nonprod"}',
  EPIC_RETIRING_PUBLIC_JWK: '{"kid":"nonprod-old"}',
  EPIC_PRODUCTION_CLIENT_ID: "prod-client",
  EPIC_PRODUCTION_PRIVATE_JWK: '{"kid":"prod"}',
  EPIC_PRODUCTION_RETIRING_PUBLIC_JWK: undefined,
};

describe("epicEnvironmentOf", () => {
  it("treats Epic's sandbox as non-production and every other health system as production", () => {
    expect(epicEnvironmentOf(EPIC_SANDBOX.fhirBaseUrl)).toBe("sandbox");
    expect(epicEnvironmentOf(`${EPIC_SANDBOX.fhirBaseUrl}/`)).toBe("sandbox");
    expect(epicEnvironmentOf("https://fhir.examplehealth.org/api/FHIR/R4")).toBe("production");
  });
});

describe("credentialsFor", () => {
  it("returns the client and key registered for each Epic environment", () => {
    expect(credentialsFor("sandbox", settings)).toEqual({
      clientId: "nonprod-client",
      privateJwk: '{"kid":"nonprod"}',
      retiringPublicJwk: '{"kid":"nonprod-old"}',
    });
    expect(credentialsFor("production", settings)).toEqual({
      clientId: "prod-client",
      privateJwk: '{"kid":"prod"}',
      retiringPublicJwk: undefined,
    });
  });

  it("has no production credentials until both production settings are present", () => {
    expect(credentialsFor("production", { ...settings, EPIC_PRODUCTION_PRIVATE_JWK: undefined })).toBeUndefined();
    expect(credentialsFor("production", { ...settings, EPIC_PRODUCTION_CLIENT_ID: undefined })).toBeUndefined();
  });
});

describe("publishedJwks", () => {
  it("publishes the public half of an environment's keys, or an empty set when it has none", async () => {
    const { privateKey } = await generateKeyPair("RS384", { modulusLength: 2048, extractable: true });
    const privateJwk = JSON.stringify({ ...(await exportJWK(privateKey)), kid: "key-1" });
    const retiringPublicJwk = JSON.stringify({ kty: "RSA", n: "old-n", e: "AQAB", kid: "key-0" });

    const jwks = publishedJwks({ clientId: "c", privateJwk, retiringPublicJwk });
    expect(jwks.keys.map((key) => key.kid)).toEqual(["key-1", "key-0"]);
    expect(jwks.keys.some((key) => "d" in key)).toBe(false);
    expect(publishedJwks(undefined)).toEqual({ keys: [] });
  });
});
