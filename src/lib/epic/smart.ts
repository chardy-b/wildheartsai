import { z } from "zod";
import { EpicError } from "./errors";

const smartSchema = z.object({
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

export type SmartConfiguration = { authorizationEndpoint: string; tokenEndpoint: string };

export async function discoverSmartConfiguration(
  fhirBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmartConfiguration> {
  const url = `${fhirBaseUrl.replace(/\/+$/, "")}/.well-known/smart-configuration`;
  const response = await fetchImpl(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new EpicError("discovery", response.status);

  const parsed = smartSchema.safeParse(await response.json());
  if (!parsed.success) throw new EpicError("discovery", undefined, "invalid_configuration");
  const { authorization_endpoint, token_endpoint, code_challenge_methods_supported } = parsed.data;

  if (!authorization_endpoint.startsWith("https://") || !token_endpoint.startsWith("https://")) {
    throw new EpicError("discovery", undefined, "insecure_endpoint");
  }
  if (code_challenge_methods_supported && !code_challenge_methods_supported.includes("S256")) {
    throw new EpicError("discovery", undefined, "pkce_unsupported");
  }
  return { authorizationEndpoint: authorization_endpoint, tokenEndpoint: token_endpoint };
}
