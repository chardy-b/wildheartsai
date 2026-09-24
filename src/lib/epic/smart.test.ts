import { describe, expect, it, vi } from "vitest";
import { EpicError } from "./errors";
import { discoverSmartConfiguration } from "./smart";

const config = {
  authorization_endpoint: "https://fhir.example.org/oauth2/authorize",
  token_endpoint: "https://fhir.example.org/oauth2/token",
  code_challenge_methods_supported: ["S256"],
};

describe("discoverSmartConfiguration", () => {
  it("reads the endpoints from .well-known/smart-configuration", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(config));
    const result = await discoverSmartConfiguration("https://fhir.example.org/api/FHIR/R4/", fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://fhir.example.org/api/FHIR/R4/.well-known/smart-configuration");
    expect(result).toEqual({
      authorizationEndpoint: config.authorization_endpoint,
      tokenEndpoint: config.token_endpoint,
    });
  });

  it("rejects non-https endpoints", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ...config, token_endpoint: "http://fhir.example.org/token" }));
    await expect(discoverSmartConfiguration("https://fhir.example.org/R4", fetchImpl)).rejects.toThrow(EpicError);
  });

  it("rejects servers that do not support S256", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ...config, code_challenge_methods_supported: ["plain"] }));
    await expect(discoverSmartConfiguration("https://fhir.example.org/R4", fetchImpl)).rejects.toThrow(/pkce_unsupported/);
  });

  it("reports HTTP failures with the discovery stage", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(discoverSmartConfiguration("https://fhir.example.org/R4", fetchImpl)).rejects.toMatchObject({
      stage: "discovery",
      status: 404,
    });
  });
});
