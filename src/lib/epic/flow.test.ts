import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeFlow, encodeFlow, type Flow } from "./flow";

const key = randomBytes(32);
const flow: Flow = {
  state: "state-1",
  verifier: "verifier-1",
  fhirBaseUrl: "https://fhir.example.org/api/FHIR/R4",
  organizationName: "Example Health",
  tokenEndpoint: "https://fhir.example.org/oauth2/token",
  createdAt: Date.parse("2026-09-23T10:00:00Z"),
};

describe("flow cookie", () => {
  it("round-trips within ten minutes", () => {
    expect(decodeFlow(encodeFlow(flow, key), key, new Date("2026-09-23T10:09:59Z"))).toEqual(flow);
  });

  it("expires after ten minutes", () => {
    expect(decodeFlow(encodeFlow(flow, key), key, new Date("2026-09-23T10:10:01Z"))).toBeNull();
  });

  it("returns null for missing, tampered or foreign values", () => {
    const now = new Date("2026-09-23T10:01:00Z");
    expect(decodeFlow(undefined, key, now)).toBeNull();
    expect(decodeFlow("garbage", key, now)).toBeNull();
    expect(decodeFlow(encodeFlow(flow, randomBytes(32)), key, now)).toBeNull();
  });

  it("does not expose the verifier in the cookie value", () => {
    expect(encodeFlow(flow, key)).not.toContain("verifier-1");
  });
});
