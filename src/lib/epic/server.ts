import "server-only";
import { keyFromBase64 } from "@/lib/crypto/seal";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { freshAccessToken } from "./access";
import { createClientAssertion, parsePrivateJwk, type EpicEnvironment } from "./client-assertion";
import { updateTokens, type ConnectionSecrets } from "./connections";
import { credentialsFor, epicEnvironmentOf, publishedJwks, type EpicCredentials } from "./credentials";
import { ReconnectRequiredError } from "./errors";
import { refreshAccessToken } from "./tokens";

export function tokenKey(): Buffer {
  return keyFromBase64(env().TOKEN_ENCRYPTION_KEY);
}

// The sandbox or production client, depending on which Epic system the health system is on.
// Undefined for a production health system while production credentials aren't configured.
export function credentialsForOrganization(fhirBaseUrl: string): EpicCredentials | undefined {
  return credentialsFor(epicEnvironmentOf(fhirBaseUrl), env());
}

export function jwksResponse(environment: EpicEnvironment): Response {
  return Response.json(publishedJwks(credentialsFor(environment, env())), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}

export function clientAssertionFor(tokenEndpoint: string, credentials: EpicCredentials): Promise<string> {
  return createClientAssertion({
    clientId: credentials.clientId,
    tokenEndpoint,
    privateJwk: parsePrivateJwk(credentials.privateJwk),
  });
}

export function accessTokenFor(connection: ConnectionSecrets): Promise<string> {
  return freshAccessToken(connection, {
    now: new Date(),
    refresh: async (c) => {
      const credentials = credentialsForOrganization(c.fhirBaseUrl);
      if (!c.refreshToken || !credentials) throw new ReconnectRequiredError();
      return refreshAccessToken({
        tokenEndpoint: c.tokenEndpoint,
        refreshToken: c.refreshToken,
        clientId: credentials.clientId,
        clientAssertion: await clientAssertionFor(c.tokenEndpoint, credentials),
      });
    },
    persist: (id, tokens) => updateTokens(db, tokenKey(), id, tokens, new Date()),
  });
}
