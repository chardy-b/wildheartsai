import "server-only";
import { keyFromBase64 } from "@/lib/crypto/seal";
import { env } from "@/lib/env";
import { createClientAssertion, parsePrivateJwk, type PrivateJwk } from "./client-assertion";

export function tokenKey(): Buffer {
  return keyFromBase64(env().TOKEN_ENCRYPTION_KEY);
}

export function epicPrivateJwk(): PrivateJwk {
  return parsePrivateJwk(env().EPIC_PRIVATE_JWK);
}

export function clientAssertionFor(tokenEndpoint: string): Promise<string> {
  return createClientAssertion({ clientId: env().EPIC_CLIENT_ID, tokenEndpoint, privateJwk: epicPrivateJwk() });
}
