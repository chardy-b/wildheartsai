import { describe, expect, it, vi } from "vitest";
import { freshAccessToken } from "./access";
import type { ConnectionSecrets } from "./connections";
import { ReconnectRequiredError } from "./errors";

const now = new Date("2026-09-23T10:00:00Z");
const connection = (overrides: Partial<ConnectionSecrets> = {}): ConnectionSecrets => ({
  id: "conn-1",
  organizationName: "Example Health",
  fhirBaseUrl: "https://fhir.example.org/api/FHIR/R4",
  scope: "s",
  connectedAt: now,
  tokenEndpoint: "https://fhir.example.org/oauth2/token",
  patientId: "p",
  accessToken: "at-old",
  refreshToken: "rt",
  accessTokenExpiresAt: new Date("2026-09-23T10:30:00Z"),
  ...overrides,
});

describe("freshAccessToken", () => {
  it("returns the stored token while it has more than a minute left", async () => {
    const refresh = vi.fn();
    expect(await freshAccessToken(connection(), { now, refresh, persist: vi.fn() })).toBe("at-old");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes and persists a token that is about to expire", async () => {
    const newTokens = { accessToken: "at-new", expiresAt: new Date("2026-09-23T11:00:00Z"), scope: "s" };
    const refresh = vi.fn().mockResolvedValue(newTokens);
    const persist = vi.fn().mockResolvedValue(undefined);
    const soon = connection({ accessTokenExpiresAt: new Date("2026-09-23T10:00:30Z") });
    expect(await freshAccessToken(soon, { now, refresh, persist })).toBe("at-new");
    expect(persist).toHaveBeenCalledWith("conn-1", newTokens);
  });

  it("asks for a reconnect when there is no refresh token", async () => {
    const expired = connection({ refreshToken: null, accessTokenExpiresAt: new Date("2026-09-23T09:00:00Z") });
    await expect(freshAccessToken(expired, { now, refresh: vi.fn(), persist: vi.fn() })).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
  });
});
