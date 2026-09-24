import type { JWK } from "jose";
import type { ServerEnv } from "@/lib/env";
import { parsePrivateJwk, publicJwks, type EpicEnvironment } from "./client-assertion";
import { isSampleData } from "./directory";

export type EpicCredentials = { clientId: string; privateJwk: string; retiringPublicJwk?: string };

type CredentialSettings = Pick<
  ServerEnv,
  | "EPIC_CLIENT_ID"
  | "EPIC_PRIVATE_JWK"
  | "EPIC_RETIRING_PUBLIC_JWK"
  | "EPIC_PRODUCTION_CLIENT_ID"
  | "EPIC_PRODUCTION_PRIVATE_JWK"
  | "EPIC_PRODUCTION_RETIRING_PUBLIC_JWK"
>;

// Epic registers one client for its sandbox (non-production) and another for
// real health systems (production), each with its own key.
export function epicEnvironmentOf(fhirBaseUrl: string): EpicEnvironment {
  return isSampleData({ fhirBaseUrl }) ? "sandbox" : "production";
}

export function credentialsFor(environment: EpicEnvironment, settings: CredentialSettings): EpicCredentials | undefined {
  if (environment === "sandbox") {
    return {
      clientId: settings.EPIC_CLIENT_ID,
      privateJwk: settings.EPIC_PRIVATE_JWK,
      retiringPublicJwk: settings.EPIC_RETIRING_PUBLIC_JWK,
    };
  }
  if (!settings.EPIC_PRODUCTION_CLIENT_ID || !settings.EPIC_PRODUCTION_PRIVATE_JWK) return undefined;
  return {
    clientId: settings.EPIC_PRODUCTION_CLIENT_ID,
    privateJwk: settings.EPIC_PRODUCTION_PRIVATE_JWK,
    retiringPublicJwk: settings.EPIC_PRODUCTION_RETIRING_PUBLIC_JWK,
  };
}

// What an environment's JWK Set URL serves. Empty until that environment has a key.
export function publishedJwks(credentials: EpicCredentials | undefined): { keys: JWK[] } {
  if (!credentials) return { keys: [] };
  const retiring = credentials.retiringPublicJwk ? (JSON.parse(credentials.retiringPublicJwk) as JWK) : undefined;
  return publicJwks(parsePrivateJwk(credentials.privateJwk), retiring);
}
