import { describe, expect, it } from "vitest";
import { clinicalDate, clinicalQuantity, documentBundleSchema, documentFhir } from "./fhir";
import type { ExtractionResult } from "./contracts";
import type { WildcardFile } from "@/lib/wildcards";

const file: WildcardFile = { id: "a1111111-1111-4111-8111-111111111111", name: "synthetic.pdf", type: "application/pdf", sizeBytes: 10, uploadedAt: "2026-10-01T00:00:00.000Z", status: "ready" };
const sourceUrl = `https://app.test/api/wildcards/${file.id}`;
const measurement = (value = "<0.05", date = "2024-02-29", unit = "mg/dL") => {
  const fields = { name: "Synthetic marker", value, date, unit, range: "0–1", page: 1 };
  return { ...fields, evidence: `${fields.name} ${value} ${unit} ${date} ${fields.range}` };
};
function result(measurements = [measurement()]): ExtractionResult {
  return { version: 1, sourceSha256: "a".repeat(64), method: "native", manifest: { private_setting: "must-not-leak" }, elapsedMs: 5,
    pages: [{ page: 1, text: measurements.map(m => m.evidence).join("\n"), words: [], tables: [], figures: [], foregroundCoverage: null,
      redaction: { rules: [], openmed: [], combined: [], text: "synthetic text" } }], totalPages: 1,
    summary: "Synthetic summary", summaryStatus: "accepted", ageAtEncounter: null, measurements, warnings: ["measurement_partial_input"] };
}
function build(value = result(), id = "b1111111-1111-4111-8111-111111111111") {
  return documentFhir({ file, sourceUrl, run: { id, createdAt: "2026-10-02T00:00:00.000Z", result: value } });
}

describe("document FHIR conversion", () => {
  it("preserves comparators, raw units, ranges and evidence without inventing patient identity or clinical codes", () => {
    const preview = build();
    const observation = preview.measurements[0].resource;
    expect(observation).toMatchObject({ resourceType: "Observation", status: "unknown", code: { text: "Synthetic marker" },
      effectiveDateTime: "2024-02-29", valueQuantity: { value: 0.05, comparator: "<", unit: "mg/dL" }, referenceRange: [{ text: "0–1" }] });
    expect(observation).not.toHaveProperty("subject");
    expect(observation.code).not.toHaveProperty("coding");
    expect(observation.valueQuantity).not.toHaveProperty("system");
    expect(observation.note.some(n => n.text.includes(measurement().evidence))).toBe(true);
    expect(preview.bundle).not.toHaveProperty("total");
    expect(JSON.stringify(preview.bundle)).not.toContain("must-not-leak");
    expect(preview.warnings).toContain("Extraction: measurement_partial_input");
    expect(documentBundleSchema.safeParse({ ...preview.bundle, total: 5 }).success).toBe(false);
  });

  it("keeps unsupported values and ambiguous dates as source text", () => {
    const preview = build(result([measurement("1,234", "03/04/2024", "")]));
    const { resource, issues } = preview.measurements[0];
    expect(resource.valueString).toBe("1,234");
    expect(resource).not.toHaveProperty("valueQuantity");
    expect(resource).not.toHaveProperty("effectiveDateTime");
    expect(issues).toHaveLength(3);
    expect(resource.note.some(n => n.text.includes("03/04/2024"))).toBe(true);
  });

  it("maps only literal dates and quantities whose representation is safe", () => {
    expect(clinicalDate("2024")).toBe("2024");
    expect(clinicalDate("2024-02")).toBe("2024-02");
    for (const value of ["2023-02-29", "2024-13", "yesterday", "2024-02-30", "2024-01-01T12:00:00"]) expect(clinicalDate(value)).toBeUndefined();
    expect(clinicalQuantity("≥ 3.2", "mU")).toEqual({ value: 3.2, comparator: ">=", unit: "mU" });
    for (const value of ["1,5", "1e10", "9999999999999999", "0.1234567890123456", "NaN", "10-20", "01", "positive"]) expect(clinicalQuantity(value, "")).toBeUndefined();
  });

  it("deduplicates exact repeated candidates, keeps run identities separate and resolves every reference", () => {
    const a = build(result([measurement(), measurement()]));
    expect(a.measurements).toHaveLength(1);
    expect(a.measurements[0].resource.id).toBe(build().measurements[0].resource.id);
    expect(a.measurements[0].resource.id).not.toBe(build(result(), "c1111111-1111-4111-8111-111111111111").measurements[0].resource.id);
    expect(documentBundleSchema.safeParse(a.bundle).success).toBe(true);
    const withoutSource = { ...a.bundle, entry: a.bundle.entry.slice(1) };
    expect(documentBundleSchema.safeParse(withoutSource).success).toBe(false);
    expect(documentBundleSchema.safeParse({ ...a.bundle, entry: [...a.bundle.entry, a.bundle.entry[0]] }).success).toBe(false);
  });

  it("represents the summary separately from the original and omits withheld summaries", () => {
    const preview = build();
    const summary = preview.bundle.entry.find(e => e.resource.resourceType === "DocumentReference" && e.resource.relatesTo)?.resource;
    expect(summary?.resourceType).toBe("DocumentReference");
    if (summary?.resourceType !== "DocumentReference") throw new Error("Missing summary");
    expect(Buffer.from(summary.content[0].attachment.data!, "base64").toString("utf8")).toBe("Synthetic summary");
    expect(preview.summary).toBe("Synthetic summary");
    const withheld = build({ ...result(), summary: "", summaryStatus: "withheld" });
    expect(withheld.summary).toBeNull();
    expect(withheld.bundle.entry.filter(e => e.resource.resourceType === "DocumentReference")).toHaveLength(1);
  });

  it("provides a source document even before extraction and rejects unsupported evidence", () => {
    const preview = documentFhir({ file, sourceUrl });
    expect(preview.bundle.entry).toHaveLength(1);
    expect(preview.measurements).toEqual([]);
    expect(preview.bundle.entry[0].resource).toMatchObject({ content: [{ attachment: { url: sourceUrl } }] });
    expect(() => build({ ...result(), measurements: [{ ...measurement(), evidence: "invented evidence" }] })).toThrow();
  });
});
