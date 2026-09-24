import { z } from "zod";
import { CLIENT_ASSERTION_TYPE } from "./client-assertion";
import { EpicError, ReconnectRequiredError, type EpicStage } from "./errors";

const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive(),
  scope: z.string(),
  refresh_token: z.string().min(1).optional(),
  patient: z.string().min(1).optional(),
});

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
  patientId?: string;
};

export type InitialTokenSet = TokenSet & { patientId: string };

type Common = { tokenEndpoint: string; clientId: string; clientAssertion: string; fetchImpl?: typeof fetch; now?: Date };

async function postToken(
  stage: Extract<EpicStage, "token" | "refresh">,
  { tokenEndpoint, clientId, clientAssertion, fetchImpl = fetch, now = new Date() }: Common,
  grant: Record<string, string>,
): Promise<TokenSet> {
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      ...grant,
      client_id: clientId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: clientAssertion,
    }),
    cache: "no-store",
  });

  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof json === "object" && json && "error" in json ? String(json.error) : undefined;
    if (stage === "refresh" && code === "invalid_grant") throw new ReconnectRequiredError();
    throw new EpicError(stage, response.status, code);
  }

  const parsed = tokenResponse.safeParse(json);
  if (!parsed.success) throw new EpicError(stage, response.status, "invalid_token_response");
  const data = parsed.data;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(now.getTime() + data.expires_in * 1000),
    scope: data.scope,
    patientId: data.patient,
  };
}

export async function exchangeCode(
  input: Common & { code: string; codeVerifier: string; redirectUri: string },
): Promise<InitialTokenSet> {
  const tokens = await postToken("token", input, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  if (!tokens.patientId) throw new EpicError("token", undefined, "missing_patient");
  return { ...tokens, patientId: tokens.patientId };
}

export function refreshAccessToken(input: Common & { refreshToken: string }): Promise<TokenSet> {
  return postToken("refresh", input, { grant_type: "refresh_token", refresh_token: input.refreshToken });
}
