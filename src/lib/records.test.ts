import { describe, expect, it } from "vitest";
import type { RecordItem } from "@/lib/fhir/normalize";
import { countByCategory, newestFirst, RECORD_QUERIES } from "./records";

function item(title: string, date: string | null, category: RecordItem["category"] = "condition"): RecordItem {
  return {
    key: title,
    category,
    title,
    date,
    detail: null,
    status: null,
    source: "North Clinic",
    resource: { resourceType: "Condition" },
    connectionId: "c1",
  };
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

// Epic grants far more than the dashboard shows (issue #11). Only these types may be read.
describe("resource allowlist", () => {
  it("searches only the resource types the dashboard displays", () => {
    expect([...new Set(RECORD_QUERIES.map((q) => q.resourceType))].sort()).toEqual([
      "AllergyIntolerance", "CarePlan", "CareTeam", "Condition", "Coverage", "Device", "DiagnosticReport", "DocumentReference",
      "Encounter", "Goal", "Immunization", "MedicationDispense", "MedicationRequest", "Observation", "Procedure", "ServiceRequest",
    ]);
    for (const q of RECORD_QUERIES) expect(q.path("p").startsWith(`${q.resourceType}?`)).toBe(true);
  });
});

describe("countByCategory", () => {
  it("counts items in every category, including zeros", () => {
    const counts = countByCategory([item("a", null), item("b", null)]);
    expect(counts.condition).toBe(2);
    expect(Object.keys(counts)).toHaveLength(18);
    expect(Object.entries(counts).filter(([category]) => category !== "condition").every(([, n]) => n === 0)).toBe(true);
  });
});

describe("newestFirst", () => {
  it("sorts newest first, partial years at their start, undated last, ties by title", () => {
    const sorted = [item("undated", null), item("old", "2019"), item("b", "2024-03-01"), item("a", "2024-03-01"), item("new", "2025-01-02T10:00:00Z")].sort(
      newestFirst,
    );
    expect(sorted.map((i) => i.title)).toEqual(["new", "a", "b", "old", "undated"]);
  });
});
