import { describe, expect, it } from "vitest";
import { RECORD_QUERIES } from "@/lib/records";
import { buildAuthorizeUrl, EPIC_SCOPES, SCOPE_LABELS } from "./authorize";

describe("buildAuthorizeUrl", () => {
  it("builds a SMART standalone launch request with PKCE and aud", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: "https://fhir.example.org/oauth2/authorize",
        clientId: "client-123",
        redirectUri: "http://localhost:3000/api/epic/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
        aud: "https://fhir.example.org/api/FHIR/R4",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://fhir.example.org/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-123",
      redirect_uri: "http://localhost:3000/api/epic/callback",
      scope: EPIC_SCOPES.join(" "),
      state: "state-1",
      aud: "https://fhir.example.org/api/FHIR/R4",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
  });

  it("requests patient launch, refresh and only SMART v2 read-and-search scopes", () => {
    expect(EPIC_SCOPES).toContain("launch/patient");
    expect(EPIC_SCOPES).toContain("offline_access");
    const resourceScopes = EPIC_SCOPES.filter((s) => s.startsWith("patient/"));
    expect(resourceScopes.length).toBeGreaterThan(0);
    expect(resourceScopes.every((s) => /^patient\/[A-Za-z]+\.rs$/.test(s))).toBe(true);
  });

  it("has a plain-language label for every resource scope", () => {
    const labelled = SCOPE_LABELS.map((item) => item.scope);
    for (const scope of EPIC_SCOPES.filter((s) => s.startsWith("patient/"))) expect(labelled).toContain(scope);
  });
});

describe("EPIC_SCOPES and the record queries", () => {
  it("requests a read-and-search scope for every resource type the dashboard reads, plus Binary for note text", () => {
    const requested = new Set(EPIC_SCOPES.filter((s) => s.startsWith("patient/")).map((s) => s.slice("patient/".length, -".rs".length)));
    for (const query of RECORD_QUERIES) expect(requested).toContain(query.resourceType);
    expect(requested).toContain("Binary");
    expect(requested).toContain("Patient");
  });
});
