import "server-only";
import { keyFromBase64 } from "@/lib/crypto/seal";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { freshAccessToken } from "./access";
import { createClientAssertion, parsePrivateJwk, type PrivateJwk } from "./client-assertion";
import { updateTokens, type ConnectionSecrets } from "./connections";
import { ReconnectRequiredError } from "./errors";
import { refreshAccessToken } from "./tokens";

export function tokenKey(): Buffer {
  return keyFromBase64(env().TOKEN_ENCRYPTION_KEY);
}

export function epicPrivateJwk(): PrivateJwk {
  return parsePrivateJwk(env().EPIC_PRIVATE_JWK);
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
