import "server-only";
import type { JWK } from "jose";
import { keyFromBase64 } from "@/lib/crypto/seal";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { freshAccessToken } from "./access";
import { createClientAssertion, jwksFor, parsePrivateJwk, type EpicEnvironment, type PrivateJwk } from "./client-assertion";
import { updateTokens, type ConnectionSecrets } from "./connections";
import { ReconnectRequiredError } from "./errors";
import { refreshAccessToken } from "./tokens";

export function tokenKey(): Buffer {
  return keyFromBase64(env().TOKEN_ENCRYPTION_KEY);
}

export function epicPrivateJwk(): PrivateJwk {
  return parsePrivateJwk(env().EPIC_PRIVATE_JWK);
}

export function jwksResponse(target: EpicEnvironment): Response {
  const { EPIC_ENVIRONMENT, EPIC_RETIRING_PUBLIC_JWK } = env();
  const retiring = EPIC_RETIRING_PUBLIC_JWK ? (JSON.parse(EPIC_RETIRING_PUBLIC_JWK) as JWK) : undefined;
  return Response.json(jwksFor(target, { environment: EPIC_ENVIRONMENT, current: epicPrivateJwk(), retiring }), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}

export function clientAssertionFor(tokenEndpoint: string): Promise<string> {
  return createClientAssertion({ clientId: env().EPIC_CLIENT_ID, tokenEndpoint, privateJwk: epicPrivateJwk() });
}

export function accessTokenFor(connection: ConnectionSecrets): Promise<string> {
  return freshAccessToken(connection, {
    now: new Date(),
    refresh: async (c) => {
      if (!c.refreshToken) throw new ReconnectRequiredError();
      return refreshAccessToken({
        tokenEndpoint: c.tokenEndpoint,
        refreshToken: c.refreshToken,
        clientId: env().EPIC_CLIENT_ID,
        clientAssertion: await clientAssertionFor(c.tokenEndpoint),
      });
    },
    persist: (id, tokens) => updateTokens(db, tokenKey(), id, tokens, new Date()),
  });
}
