import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { completeAuthorization } from "./callback";
import { encodeFlow, type Flow } from "./flow";

const key = randomBytes(32);
const now = new Date("2026-09-23T10:01:00Z");
const flow: Flow = {
  state: "state-1",
  verifier: "verifier-1",
  fhirBaseUrl: "https://fhir.example.org/api/FHIR/R4",
  organizationName: "Example Health",
  tokenEndpoint: "https://fhir.example.org/oauth2/token",
  createdAt: Date.parse("2026-09-23T10:00:00Z"),
};
const tokens = { accessToken: "at", refreshToken: "rt", expiresAt: now, scope: "s", patientId: "p" };

function deps(overrides: Partial<Parameters<typeof completeAuthorization>[0]> = {}) {
  return {
    params: { code: "code-1", state: "state-1", error: null },
    flowCookie: encodeFlow(flow, key),
    key,
    now,
    exchange: vi.fn().mockResolvedValue(tokens),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("completeAuthorization", () => {
  it("exchanges the code with the stored verifier and saves the connection", async () => {
    const d = deps();
    expect(await completeAuthorization(d)).toEqual({ ok: true });
    expect(d.exchange).toHaveBeenCalledWith({
      fhirBaseUrl: flow.fhirBaseUrl,
      tokenEndpoint: flow.tokenEndpoint,
      code: "code-1",
      codeVerifier: "verifier-1",
    });
    expect(d.save).toHaveBeenCalledWith(flow, tokens);
  });

  it("reports a denial from MyChart without exchanging anything", async () => {
    const d = deps({ params: { code: null, state: "state-1", error: "access_denied" } });
    expect(await completeAuthorization(d)).toEqual({ ok: false, reason: "denied" });
    expect(d.exchange).not.toHaveBeenCalled();
  });

  it("rejects a missing or expired flow cookie", async () => {
    expect(await completeAuthorization(deps({ flowCookie: undefined }))).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a state mismatch", async () => {
    const d = deps({ params: { code: "code-1", state: "someone-else", error: null } });
    expect(await completeAuthorization(d)).toEqual({ ok: false, reason: "invalid_state" });
    expect(d.exchange).not.toHaveBeenCalled();
  });

  it("reports token failures without saving", async () => {
    const d = deps({ exchange: vi.fn().mockRejectedValue(new Error("boom")) });
    expect(await completeAuthorization(d)).toEqual({ ok: false, reason: "token_failed" });
    expect(d.save).not.toHaveBeenCalled();
  });
});
