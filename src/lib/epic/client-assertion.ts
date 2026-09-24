import { randomUUID } from "node:crypto";
import { importJWK, SignJWT, type JWK } from "jose";

export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ALG = "RS384";
const LIFETIME_SECONDS = 240;

export type PrivateJwk = JWK & { kid: string };

export function parsePrivateJwk(json: string): PrivateJwk {
  const jwk = JSON.parse(json) as JWK;
  if (jwk.kty !== "RSA" || !jwk.d || !jwk.kid) {
    throw new Error("EPIC_PRIVATE_JWK must be a private RSA JWK with a kid");
  }
  return jwk as PrivateJwk;
}

export async function createClientAssertion({
  clientId,
  tokenEndpoint,
  privateJwk,
  now = new Date(),
}: {
  clientId: string;
  tokenEndpoint: string;
  privateJwk: PrivateJwk;
  now?: Date;
}): Promise<string> {
  const key = await importJWK(privateJwk, ALG);
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, kid: privateJwk.kid, typ: "JWT" })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(tokenEndpoint)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + LIFETIME_SECONDS)
    .sign(key);
}

function toPublic({ kty, n, e, kid }: JWK): JWK {
  return { kty, n, e, kid, alg: ALG, use: "sig" };
}

export function publicJwks(current: JWK, retiring?: JWK): { keys: JWK[] } {
  return { keys: retiring ? [toPublic(current), toPublic(retiring)] : [toPublic(current)] };
}
