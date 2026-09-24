import { describe, expect, it, vi } from "vitest";
import {
  EPIC_ENDPOINTS_URL,
  EPIC_SANDBOX,
  findOrganization,
  loadConnectable,
  loadDirectory,
  organizationChoices,
  parseEndpoints,
  searchOrganizations,
} from "./directory";

// Same shape as Epic's published list: a FHIR Bundle of Endpoint resources.
const endpoint = (name: string, address: string, status = "active") => ({
  resource: { resourceType: "Endpoint", id: name, status, name, address },
});

const fixture = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    endpoint("Northwind Health", "https://fhir.northwind.example/api/FHIR/R4/"),
    endpoint("Alder Valley Clinics", "https://ehr.alder.example/FHIR/api/FHIR/R4"),
    endpoint("Northwind Health (duplicate)", "https://fhir.northwind.example/api/FHIR/R4"),
    endpoint("Insecure Hospital", "http://insecure.example/api/FHIR/R4"),
    endpoint("Credential URL", "https://user:password@credential.example/api/FHIR/R4"),
    endpoint("Encoded traversal", "https://traversal.example/api/FHIR/R4%2f%2e%2e%2foauth"),
    endpoint("Query URL", "https://query.example/api/FHIR/R4?redirect=elsewhere"),
    endpoint("Retired Clinic", "https://retired.example/api/FHIR/R4", "off"),
  ],
};

describe("parseEndpoints", () => {
  it("normalizes, de-duplicates, rejects unsafe URLs and sorts by name", () => {
    expect(parseEndpoints(fixture)).toEqual([
      { name: "Alder Valley Clinics", fhirBaseUrl: "https://ehr.alder.example/FHIR/api/FHIR/R4" },
      { name: "Northwind Health", fhirBaseUrl: "https://fhir.northwind.example/api/FHIR/R4" },
    ]);
  });

  it("throws on an unexpected shape", () => {
    expect(() => parseEndpoints({ entries: [] })).toThrow();
  });
});

describe("searchOrganizations", () => {
  const orgs = parseEndpoints(fixture);

  it("matches every word, ignoring case", () => {
    expect(searchOrganizations(orgs, "north HEALTH").map((o) => o.name)).toEqual(["Northwind Health"]);
    expect(searchOrganizations(orgs, "valley north")).toEqual([]);
  });

  it("returns the first results for an empty query, up to the limit", () => {
    expect(searchOrganizations(orgs, "  ", 1)).toHaveLength(1);
  });
});

describe("findOrganization", () => {
  it("finds an allowed base URL with or without a trailing slash", () => {
    const orgs = parseEndpoints(fixture);
    expect(findOrganization(orgs, "https://fhir.northwind.example/api/FHIR/R4/")?.name).toBe("Northwind Health");
    expect(findOrganization(orgs, "https://evil.example/api/FHIR/R4")).toBeUndefined();
  });
});

describe("loadDirectory", () => {
  it("offers only the Epic sandbox in sandbox mode, without a network call", async () => {
    const fetchImpl = vi.fn();
    expect(await loadDirectory("sandbox", fetchImpl)).toEqual([EPIC_SANDBOX]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("loads Epic's published endpoints in production mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(fixture));
    const orgs = await loadDirectory("production", fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe(EPIC_ENDPOINTS_URL);
    expect(orgs).toHaveLength(2);
  });

  it("throws when the list is unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("down", { status: 503 }));
    await expect(loadDirectory("production", fetchImpl)).rejects.toThrow(/503/);
  });
});

describe("loadConnectable", () => {
  it("accepts the sandbox as sample data alongside real health systems in production", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(fixture));
    const orgs = await loadConnectable("production", fetchImpl);
    expect(orgs[0]).toEqual(EPIC_SANDBOX);
    expect(orgs).toHaveLength(3);
  });

  it("accepts only the sandbox in sandbox mode", async () => {
    expect(await loadConnectable("sandbox", vi.fn())).toEqual([EPIC_SANDBOX]);
  });
});

describe("organizationChoices", () => {
  const real = [
    { name: "Northwind Health", fhirBaseUrl: "https://fhir.northwind.example/api/FHIR/R4" },
    { name: "Southgate Clinic", fhirBaseUrl: "https://fhir.southgate.example/api/FHIR/R4" },
  ];

  it("in production, searches real health systems and offers the sandbox separately as sample data", () => {
    const connectable = [EPIC_SANDBOX, ...real];
    expect(organizationChoices("production", connectable, new Set(), "")).toEqual({ results: [], sample: EPIC_SANDBOX });
    expect(organizationChoices("production", connectable, new Set(), "north")).toEqual({ results: [real[0]], sample: EPIC_SANDBOX });
    expect(organizationChoices("production", connectable, new Set(), "epic").results).toEqual([]);
  });

  it("leaves out what is already connected", () => {
    const connected = new Set([EPIC_SANDBOX.fhirBaseUrl, real[0].fhirBaseUrl]);
    expect(organizationChoices("production", [EPIC_SANDBOX, ...real], connected, "health")).toEqual({ results: [], sample: null });
  });

  it("in sandbox mode, lists the sandbox without a search and no separate sample", () => {
    expect(organizationChoices("sandbox", [EPIC_SANDBOX], new Set(), "")).toEqual({ results: [EPIC_SANDBOX], sample: null });
  });
});
