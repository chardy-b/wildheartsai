import { decodeFlow, type Flow } from "./flow";
import { safeEqual } from "./pkce";
import type { InitialTokenSet } from "./tokens";

export type CallbackFailure = "denied" | "expired" | "invalid_state" | "token_failed";

export async function completeAuthorization(deps: {
  params: { code: string | null; state: string | null; error: string | null };
  flowCookie: string | undefined;
  key: Buffer;
  now: Date;
  exchange: (input: { fhirBaseUrl: string; tokenEndpoint: string; code: string; codeVerifier: string }) => Promise<InitialTokenSet>;
  save: (flow: Flow, tokens: InitialTokenSet) => Promise<void>;
}): Promise<{ ok: true } | { ok: false; reason: CallbackFailure }> {
  const { params } = deps;
  if (params.error) return { ok: false, reason: "denied" };

  const flow = decodeFlow(deps.flowCookie, deps.key, deps.now);
  if (!flow) return { ok: false, reason: "expired" };
  if (!params.code || !params.state || !safeEqual(params.state, flow.state)) {
    return { ok: false, reason: "invalid_state" };
  }

  let tokens: InitialTokenSet;
  try {
    tokens = await deps.exchange({
      fhirBaseUrl: flow.fhirBaseUrl,
      tokenEndpoint: flow.tokenEndpoint,
      code: params.code,
      codeVerifier: flow.verifier,
    });
  } catch (error) {
    console.error("[epic] token exchange failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, reason: "token_failed" };
  }

  await deps.save(flow, tokens);
  return { ok: true };
}
