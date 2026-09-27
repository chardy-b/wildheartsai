import { describe, expect, it } from "vitest";
import { RECORD_QUERIES } from "@/lib/records";
import { buildAuthorizeUrl, EPIC_SCOPES, EXPANDED_SCOPES, grantsResource, missingScopes, requestedScopes, SCOPE_LABELS, scopeLabels } from "./authorize";

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
    // With the stage 8 scopes on; without them, those searches are skipped (see grantsResource).
    const requested = new Set(requestedScopes(true).filter((s) => s.startsWith("patient/")).map((s) => s.slice("patient/".length, -".rs".length)));
    for (const query of RECORD_QUERIES) expect(requested).toContain(query.resourceType);
    expect(requested).toContain("Binary");
    expect(requested).toContain("Patient");
  });
});

describe("expanded scopes", () => {
  it("adds the stage 8 scopes only when switched on, each with a label", () => {
    expect(requestedScopes(false)).toEqual(EPIC_SCOPES);
    expect(requestedScopes(true)).toEqual([...EPIC_SCOPES, ...EXPANDED_SCOPES]);
    expect(scopeLabels(false).map((l) => l.scope)).not.toContain("patient/Appointment.rs");
    expect(scopeLabels(true).map((l) => l.scope)).toEqual(expect.arrayContaining([...EXPANDED_SCOPES]));
    const labelled = SCOPE_LABELS.map((item) => item.scope);
    for (const scope of EXPANDED_SCOPES) expect(labelled).toContain(scope);
  });

  it("reads granted scopes in SMART v1 or v2 form, and wildcards", () => {
    expect(grantsResource("openid patient/Appointment.rs", "Appointment")).toBe(true);
    expect(grantsResource("patient/Appointment.read", "Appointment")).toBe(true);
    expect(grantsResource("patient/*.read", "FamilyMemberHistory")).toBe(true);
    expect(grantsResource("patient/Condition.rs", "Appointment")).toBe(false);
    expect(grantsResource("user/Appointment.rs", "Appointment")).toBe(false);
  });

  it("lists what a connection is missing, for the reconnect prompt", () => {
    const original = EPIC_SCOPES.join(" ");
    expect(missingScopes(original, false)).toEqual([]);
    expect(missingScopes(original, true)).toEqual([...EXPANDED_SCOPES]);
    expect(missingScopes(requestedScopes(true).join(" "), true)).toEqual([]);
  });
});
