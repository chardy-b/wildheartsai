import { describe, expect, it, vi } from "vitest";
import type { ConnectionSecrets } from "@/lib/epic/connections";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import type { Resource } from "@/lib/fhir/types";
import { countByCategory, gatherRecords, RECORD_QUERIES } from "./records";

function connection(name: string, base: string): ConnectionSecrets {
  return {
    id: name,
    organizationName: name,
    fhirBaseUrl: base,
    scope: "s",
    connectedAt: new Date(),
    tokenEndpoint: `${base}/token`,
    patientId: `patient-${name}`,
    accessToken: "at",
    refreshToken: "rt",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  };
}

const north = connection("North Clinic", "https://north.example/R4");
const south = connection("South Hospital", "https://south.example/R4");

function fakeSearch(byBase: Record<string, Partial<Record<string, Resource[]>>>) {
  return vi.fn(async ({ baseUrl, resourceType }: { baseUrl: string; resourceType: string; path: string }) => ({
    resources: byBase[baseUrl]?.[resourceType] ?? [],
    truncated: false,
  }));
}

describe("RECORD_QUERIES", () => {
  it("scopes every search to the patient, with the categories Epic requires", () => {
    const paths = RECORD_QUERIES.map((q) => q.path("p 1"));
    expect(paths).toEqual([
      "Condition?patient=p%201&category=problem-list-item",
      "MedicationRequest?patient=p%201",
      "AllergyIntolerance?patient=p%201",
      "Observation?patient=p%201&category=laboratory",
      "Immunization?patient=p%201",
      "Encounter?patient=p%201",
      "DiagnosticReport?patient=p%201",
      "DocumentReference?patient=p%201&category=clinical-note",
      "Procedure?patient=p%201",
      "Observation?patient=p%201&category=vital-signs",
      "Observation?patient=p%201&category=social-history",
      "CareTeam?patient=p%201",
      "CarePlan?patient=p%201&category=38717003",
      "Goal?patient=p%201",
      "ServiceRequest?patient=p%201",
      "MedicationDispense?patient=p%201",
      "Device?patient=p%201",
      "Coverage?patient=p%201",
    ]);
  });
});

describe("gatherRecords", () => {
  it("merges every connection, tags the source and sorts newest first", async () => {
    const search = fakeSearch({
      [north.fhirBaseUrl]: { Condition: [{ resourceType: "Condition", id: "c1", code: { text: "Asthma" }, onsetDateTime: "2019-01-01" } as Resource] },
      [south.fhirBaseUrl]: { Immunization: [{ resourceType: "Immunization", id: "i1", vaccineCode: { text: "Influenza" }, occurrenceDateTime: "2024-10-01" } as Resource] },
    });
    const result = await gatherRecords([north, south], { accessToken: async () => "at", search });

    expect(result.problems).toEqual([]);
    expect(result.items.map((i) => [i.title, i.source])).toEqual([
      ["Influenza", "South Hospital"],
      ["Asthma", "North Clinic"],
    ]);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: north.fhirBaseUrl, path: "Condition?patient=patient-North%20Clinic&category=problem-list-item" }));
  });

  it("keeps other connections when one needs to reconnect", async () => {
    const search = fakeSearch({
      [south.fhirBaseUrl]: { Encounter: [{ resourceType: "Encounter", id: "e1", period: { start: "2025-01-01" } } as Resource] },
    });
    const accessToken = vi.fn(async (c: ConnectionSecrets) => {
      if (c.id === north.id) throw new ReconnectRequiredError();
      return "at";
    });
    const result = await gatherRecords([north, south], { accessToken, search });
    expect(result.problems).toEqual([{ organizationName: "North Clinic", kind: "reconnect" }]);
    expect(result.items).toHaveLength(1);
  });

  it("reports a connection once when some of its searches fail", async () => {
    const search = vi.fn(async ({ resourceType }: { resourceType: string }) => {
      if (resourceType === "Encounter" || resourceType === "Immunization") throw new EpicError("fhir", 400);
      if (resourceType === "Condition") return { resources: [{ resourceType: "Condition", id: "c1" } as Resource], truncated: false };
      return { resources: [], truncated: false };
    });
    const result = await gatherRecords([north], { accessToken: async () => "at", search });
    expect(result.problems).toEqual([{ organizationName: "North Clinic", kind: "unavailable" }]);
    expect(result.items).toHaveLength(1);
  });

  it("puts undated items last", async () => {
    const search = fakeSearch({
      [north.fhirBaseUrl]: {
        Condition: [
          { resourceType: "Condition", id: "undated", code: { text: "B" } } as Resource,
          { resourceType: "Condition", id: "dated", code: { text: "A" }, recordedDate: "2020-02-02" } as Resource,
        ],
      },
    });
    const result = await gatherRecords([north], { accessToken: async () => "at", search });
    expect(result.items.map((i) => i.title)).toEqual(["A", "B"]);
  });

  it("bounds concurrent FHIR searches per connection", async () => {
    let active = 0;
    let highest = 0;
    const search = vi.fn(async () => {
      active += 1;
      highest = Math.max(highest, active);
      await Promise.resolve();
      active -= 1;
      return { resources: [], truncated: false };
    });
    await gatherRecords([north], { accessToken: async () => "at", search });
    expect(search).toHaveBeenCalledTimes(RECORD_QUERIES.length);
    expect(highest).toBe(3);
  });

  it("bounds connection fan-out and reports connections beyond the launch cap", async () => {
    const connections = Array.from({ length: 6 }, (_, index) => connection(`Clinic ${index + 1}`, `https://clinic-${index + 1}.example/R4`));
    let active = 0;
    let highest = 0;
    const accessToken = vi.fn(async () => {
      active += 1;
      highest = Math.max(highest, active);
      await Promise.resolve();
      active -= 1;
      return "at";
    });
    const result = await gatherRecords(connections, { accessToken, search: fakeSearch({}) });
    expect(accessToken).toHaveBeenCalledTimes(5);
    expect(highest).toBe(2);
    expect(result.problems).toContainEqual({ organizationName: "Clinic 6", kind: "unavailable" });
  });
});

describe("countByCategory", () => {
  it("counts items in every category, including zeros", async () => {
    const search = fakeSearch({
      [north.fhirBaseUrl]: { Condition: [{ resourceType: "Condition", id: "c1" } as Resource, { resourceType: "Condition", id: "c2" } as Resource] },
    });
    const { items } = await gatherRecords([north], { accessToken: async () => "at", search });
    const counts = countByCategory(items);
    expect(counts.condition).toBe(2);
    expect(Object.keys(counts)).toHaveLength(18);
    expect(Object.entries(counts).filter(([category]) => category !== "condition").every(([, n]) => n === 0)).toBe(true);
  });
});

// Epic grants far more than the dashboard shows (issue #11). Only these types may be read.
describe("resource allowlist", () => {
  it("searches only the resource types the dashboard displays", async () => {
    const search = fakeSearch({});
    await gatherRecords([north, south], { accessToken: async () => "at", search });
    const requested = new Set(search.mock.calls.map(([input]) => input.resourceType));
    expect([...requested].sort()).toEqual([
      "AllergyIntolerance", "CarePlan", "CareTeam", "Condition", "Coverage", "Device", "DiagnosticReport", "DocumentReference",
      "Encounter", "Goal", "Immunization", "MedicationDispense", "MedicationRequest", "Observation", "Procedure", "ServiceRequest",
    ]);
    for (const [input] of search.mock.calls) expect(input.path.startsWith(`${input.resourceType}?`)).toBe(true);
  });
});

describe("record items", () => {
  it("carry the resource they came from and the connection that fetched it, for the detail view", async () => {
    const resource = { resourceType: "Condition", id: "c1", code: { text: "Asthma" } } as Resource;
    const search = fakeSearch({ [north.fhirBaseUrl]: { Condition: [resource] } });
    const { items } = await gatherRecords([north], { accessToken: async () => "at", search });
    expect(items[0]).toMatchObject({ title: "Asthma", resource, connectionId: north.id });
  });
});

describe("failure logging", () => {
  it("says which search failed and why, with the error code when there's no HTTP status", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const search = vi.fn(async ({ path }: { path: string }) => {
      if (path.includes("category=laboratory")) throw new EpicError("fhir", undefined, "resource_limit");
      if (path.startsWith("Encounter")) throw new EpicError("fhir", 400);
      if (path.startsWith("Goal")) throw new TypeError("fetch failed");
      return { resources: [], truncated: false };
    });
    await gatherRecords([north], { accessToken: async () => "at", search });
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain("[records] Observation (lab) failed resource_limit");
    expect(lines).toContain("[records] Encounter (visit) failed 400");
    expect(lines).toContain("[records] Goal (goal) failed network");
    log.mockRestore();
  });
});

describe("partial results", () => {
  it("keeps what a capped search returned and says which categories are incomplete", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const vital = { resourceType: "Observation", id: "v1", code: { text: "Pulse" } } as Resource;
    const search = vi.fn(async ({ path }: { path: string }) =>
      path.includes("category=vital-signs") ? { resources: [vital], truncated: true } : { resources: [], truncated: false },
    );
    const result = await gatherRecords([north], { accessToken: async () => "at", search });
    expect(result.items.map((i) => i.title)).toEqual(["Pulse"]);
    expect(result.problems).toEqual([{ organizationName: "North Clinic", kind: "partial", categories: ["vital"] }]);
    expect(log.mock.calls.map((c) => String(c[0]))).toContain("[records] Observation (vital) truncated");
    log.mockRestore();
  });

  it("asks for up to 500 results for high-volume observation searches and the default for the rest", async () => {
    const search = fakeSearch({});
    await gatherRecords([north], { accessToken: async () => "at", search });
    const caps = Object.fromEntries(search.mock.calls.map(([input]) => [input.path.split("&category=")[1] ?? input.resourceType, (input as { maxResources?: number }).maxResources]));
    expect(caps).toMatchObject({ laboratory: 500, "vital-signs": 500, "social-history": 500, Encounter: undefined });
  });
});
