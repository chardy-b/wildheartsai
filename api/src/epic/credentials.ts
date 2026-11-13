import { createClientAssertion, parsePrivateJwk, type EpicEnvironment } from "@/lib/epic/client-assertion";
import { credentialsFor, epicEnvironmentOf, publishedJwks, type EpicCredentials } from "@/lib/epic/credentials";
import { keyFromBase64 } from "../crypto/seal";
import type { Secrets } from "../env";

// Epic client credentials and keys (src/lib/epic/server.ts in the Next app), from Worker secrets.

export function tokenKey(config: Secrets): Buffer {
  return keyFromBase64(config.TOKEN_ENCRYPTION_KEY);
}

// The key-encryption key for stored health records. Separate from tokenKey so one leaked key
// doesn't expose both tokens and records.
export function recordsKey(config: Secrets): Buffer {
  return keyFromBase64(config.RECORDS_ENCRYPTION_KEY);
}

// The sandbox or production client, depending on which Epic system the health system is on.
// Undefined for a production health system while production access is disabled.
export function credentialsForOrganization(config: Secrets, fhirBaseUrl: string): EpicCredentials | undefined {
  const environment = epicEnvironmentOf(fhirBaseUrl);
  if (environment === "production" && !config.EPIC_PRODUCTION_ACCESS_ENABLED) return undefined;
  return credentialsFor(environment, config);
}

export function jwksResponse(config: Secrets, environment: EpicEnvironment): Response {
  if (environment === "production" && !config.EPIC_PRODUCTION_ACCESS_ENABLED) {
    return Response.json({ keys: [] }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json(publishedJwks(credentialsFor(environment, config)), { headers: { "Cache-Control": "public, max-age=3600" } });
}

export function clientAssertionFor(tokenEndpoint: string, credentials: EpicCredentials): Promise<string> {
  return createClientAssertion({ clientId: credentials.clientId, tokenEndpoint, privateJwk: parsePrivateJwk(credentials.privateJwk) });
}
