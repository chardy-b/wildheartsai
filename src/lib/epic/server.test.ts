import { beforeEach, describe, expect, it, vi } from "vitest";
import { EpicError, ReconnectRequiredError } from "./errors";
import type { ConnectionSecrets } from "./connections";
import { accessTokenFor } from "./server";

const state = vi.hoisted(() => ({ current: undefined as ConnectionSecrets | undefined }));
vi.mock("@/lib/db", () => ({ db: { transaction: (work: (tx: object) => unknown) => work({}) } }));
vi.mock("./connections", () => ({ getConnectionSecretForUpdate: () => state.current, updateTokens: vi.fn() }));

beforeEach(() => {
  state.current = {
    id: "test-connection", organizationName: "Example Health", fhirBaseUrl: "https://fhir.example/R4",
    scope: "patient/Patient.rs", connectedAt: new Date(0), tokenEndpoint: "https://fhir.example/token",
    patientId: "test-patient", accessToken: "test-access", refreshToken: "test-refresh", accessTokenExpiresAt: new Date(0),
  };
});

describe("server token refresh classification", () => {
  it("reports unavailable production credentials as an app failure", async () => {
    await expect(accessTokenFor(state.current!)).rejects.toMatchObject({ stage: "refresh", code: "missing_credentials" });
    await expect(accessTokenFor(state.current!)).rejects.toBeInstanceOf(EpicError);
  });

  it("does not tell a disconnected connection to authorize again after a race", async () => {
    const previous = state.current!;
    state.current = undefined;
    await expect(accessTokenFor(previous)).rejects.toMatchObject({ code: "connection_unavailable" });
  });

  it("still requires authorization when no refresh token was granted", async () => {
    state.current!.refreshToken = null;
    const request = accessTokenFor(state.current!);
    await expect(request).rejects.toBeInstanceOf(ReconnectRequiredError);
    await expect(request).rejects.toMatchObject({ reason: "missing_refresh_token" });
  });
});
