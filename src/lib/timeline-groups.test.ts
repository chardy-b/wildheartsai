import { describe, expect, it } from "vitest";
import type { RecordItem } from "@/lib/fhir/normalize";
import { groupVitals, vitalsSummary } from "./timeline-groups";

const item = (title: string, category: RecordItem["category"], date: string | null, detail: string | null = null, sourceId = "s1"): RecordItem => ({
  key: `${title}-${date}-${sourceId}`,
  category,
  title,
  date,
  detail,
  status: null,
  source: sourceId === "s1" ? "North Clinic" : "South Hospital",
  sourceId,
  resource: { resourceType: "Observation" },
  connectionId: "",
});

describe("groupVitals", () => {
  it("folds a day's vitals from one organization into one entry, where the first one was", () => {
    const entries = groupVitals([
      item("Weight", "vital", "2026-09-25T10:30:00Z", "68.5 kg"),
      item("A1c", "lab", "2026-09-25T09:00:00Z"),
      item("Pulse", "vital", "2026-09-25T08:00:00Z", "64 /min"),
      item("Weight", "vital", "2026-09-24T10:00:00Z", "68.9 kg"),
    ]);
    expect(entries.map((e) => (e.kind === "vitals" ? `vitals ${e.day} x${e.items.length}` : e.item.title))).toEqual([
      "vitals 2026-09-25 x2",
      "A1c",
      "Weight",
    ]);
  });

  it("keeps different organizations' vitals apart, and leaves undated ones alone", () => {
    const entries = groupVitals([
      item("Weight", "vital", "2026-09-25", "68 kg", "s1"),
      item("Weight", "vital", "2026-09-25", "68 kg", "s2"),
      item("Pulse", "vital", "2026-09-25", "60 /min", "s2"),
      item("Height", "vital", null),
      item("Pulse", "vital", null),
    ]);
    expect(entries.map((e) => (e.kind === "vitals" ? `vitals ${e.sourceId} x${e.items.length}` : e.item.title))).toEqual([
      "Weight",
      "vitals s2 x2",
      "Height",
      "Pulse",
    ]);
  });
});

describe("vitalsSummary", () => {
  it("lists each distinct measurement once, latest first, then how many more", () => {
    const day = [
      item("Weight", "vital", "d", "68.5 kg"),
      item("Temperature", "vital", "d", "37.2 °C"),
      item("Weight", "vital", "d", "68.9 kg"),
      item("Pulse", "vital", "d", "64 /min"),
      item("Blood pressure", "vital", "d", "120/80 mmHg"),
      item("Height", "vital", "d", "165 cm"),
    ];
    expect(vitalsSummary(day)).toBe("Weight 68.5 kg · Temperature 37.2 °C · Pulse 64 /min · and 2 more");
  });
});
