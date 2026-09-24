import "server-only";
import { keyFromBase64 } from "@/lib/crypto/seal";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { freshAccessToken, hasFreshAccessToken } from "./access";
import { createClientAssertion, parsePrivateJwk, type EpicEnvironment } from "./client-assertion";
import { getConnectionSecretForUpdate, updateTokens, type ConnectionSecrets } from "./connections";
import { credentialsFor, epicEnvironmentOf, publishedJwks, type EpicCredentials } from "./credentials";
import { ReconnectRequiredError } from "./errors";
import { refreshAccessToken } from "./tokens";

export function tokenKey(): Buffer {
  return keyFromBase64(env().TOKEN_ENCRYPTION_KEY);
}

// The sandbox or production client, depending on which Epic system the health system is on.
// Undefined for a production health system while production access is disabled or credentials aren't configured.
export function credentialsForOrganization(fhirBaseUrl: string): EpicCredentials | undefined {
  const environment = epicEnvironmentOf(fhirBaseUrl);
  const config = env();
  if (environment === "production" && !config.EPIC_PRODUCTION_ACCESS_ENABLED) return undefined;
  return credentialsFor(environment, config);
}

export function jwksResponse(environment: EpicEnvironment): Response {
  const config = env();
  if (environment === "production" && !config.EPIC_PRODUCTION_ACCESS_ENABLED) {
    return Response.json({ keys: [] }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json(publishedJwks(credentialsFor(environment, config)), {
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

export async function accessTokenFor(connection: ConnectionSecrets): Promise<string> {
  const now = new Date();
  if (hasFreshAccessToken(connection, now)) return connection.accessToken;

  const key = tokenKey();
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as typeof db;
    const current = await getConnectionSecretForUpdate(tx, key, connection.id);
    if (!current) throw new ReconnectRequiredError();
    return freshAccessToken(current, {
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
      persist: (id, tokens) => updateTokens(tx, key, id, tokens, new Date()),
    });
  });
}
