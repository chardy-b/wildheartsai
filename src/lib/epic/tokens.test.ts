import { describe, expect, it, vi } from "vitest";
import { CLIENT_ASSERTION_TYPE } from "./client-assertion";
import { EpicError, ReconnectRequiredError } from "./errors";
import { exchangeCode, refreshAccessToken } from "./tokens";

const now = new Date("2026-09-23T10:00:00Z");
const tokenEndpoint = "https://fhir.example.org/oauth2/token";

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>) {
  return Object.fromEntries(new URLSearchParams(fetchImpl.mock.calls[0][1].body));
}

describe("exchangeCode", () => {
  it("posts the code, verifier and JWT assertion and returns the token set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "at-1",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "launch/patient patient/Condition.read",
        refresh_token: "rt-1",
        patient: "pat-1",
      }),
    );
    const tokens = await exchangeCode({
      tokenEndpoint,
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "http://localhost:3000/api/epic/callback",
      clientId: "client-123",
      clientAssertion: "signed.jwt.value",
      fetchImpl,
      now,
    });

    expect(fetchImpl.mock.calls[0][0]).toBe(tokenEndpoint);
    expect(bodyOf(fetchImpl)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://localhost:3000/api/epic/callback",
      code_verifier: "verifier-1",
      client_id: "client-123",
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: "signed.jwt.value",
    });
    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: new Date("2026-09-23T11:00:00Z"),
      scope: "launch/patient patient/Condition.read",
      patientId: "pat-1",
    });
  });

  it("fails when Epic does not return a patient", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({ access_token: "at", token_type: "Bearer", expires_in: 60, scope: "openid" }),
    );
    await expect(
      exchangeCode({ tokenEndpoint, code: "c", codeVerifier: "v", redirectUri: "http://x/cb", clientId: "c", clientAssertion: "j", fetchImpl, now }),
    ).rejects.toMatchObject({ stage: "token", code: "missing_patient" });
  });

  it("reports the OAuth error code without the response body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ error: "invalid_client" }, { status: 401 }));
    const promise = exchangeCode({ tokenEndpoint, code: "c", codeVerifier: "v", redirectUri: "http://x/cb", clientId: "c", clientAssertion: "j", fetchImpl, now });
    await expect(promise).rejects.toBeInstanceOf(EpicError);
    await expect(promise).rejects.toMatchObject({ status: 401, code: "invalid_client" });
  });
});

describe("refreshAccessToken", () => {
  it("posts a refresh grant and keeps going without a new refresh token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({ access_token: "at-2", token_type: "bearer", expires_in: 1800, scope: "patient/Condition.read" }),
    );
    const tokens = await refreshAccessToken({ tokenEndpoint, refreshToken: "rt-1", clientId: "client-123", clientAssertion: "j", fetchImpl, now });
    expect(bodyOf(fetchImpl)).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-1", client_assertion: "j" });
    expect(tokens).toEqual({
      accessToken: "at-2",
      refreshToken: undefined,
      expiresAt: new Date("2026-09-23T10:30:00Z"),
      scope: "patient/Condition.read",
      patientId: undefined,
    });
  });

  it("asks for a reconnect when the refresh token is no longer valid", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(
      refreshAccessToken({ tokenEndpoint, refreshToken: "rt", clientId: "c", clientAssertion: "j", fetchImpl, now }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});
