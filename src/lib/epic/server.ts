import "server-only";
import { keyFromBase64 } from "@/lib/crypto/seal";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { freshAccessToken, hasFreshAccessToken } from "./access";
import { createClientAssertion, parsePrivateJwk, type EpicEnvironment } from "./client-assertion";
import {
  claimRefreshLease,
  getConnectionSecret,
  releaseRefreshLease,
  updateTokens,
  type ConnectionSecrets,
} from "./connections";
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

// How long one request may hold a connection's refresh, and how often others check back.
const REFRESH_LEASE_MS = 30_000;
const REFRESH_POLL_MS = 250;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function accessTokenFor(connection: ConnectionSecrets): Promise<string> {
  if (hasFreshAccessToken(connection, new Date())) return connection.accessToken;

  const key = tokenKey();
  const giveUpAt = Date.now() + REFRESH_LEASE_MS;
  for (;;) {
    const lease = await claimRefreshLease(db, connection.id, new Date(), REFRESH_LEASE_MS);
    if (lease) {
      // Read after claiming, so the refresh token is the latest one.
      const current = await getConnectionSecret(db, key, connection.id);
      if (!current) throw new ReconnectRequiredError();
      try {
        return await freshAccessToken(current, {
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
          persist: (id, tokens) => updateTokens(db, key, id, tokens, new Date()),
        });
      } finally {
        // A no-op once updateTokens has stored new tokens (which ends the lease).
        await releaseRefreshLease(db, current.id, lease);
      }
    }
    // Another request is refreshing: wait for its tokens.
    await pause(REFRESH_POLL_MS);
    const current = await getConnectionSecret(db, key, connection.id);
    if (!current) throw new ReconnectRequiredError();
    if (hasFreshAccessToken(current, new Date())) return current.accessToken;
    if (Date.now() > giveUpAt) throw new Error("Timed out waiting for another token refresh");
  }
}
