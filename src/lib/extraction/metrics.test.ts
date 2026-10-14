import { describe, expect, it } from "vitest";
import { benchmark, redactionMetrics, textMetrics } from "./metrics";
import { referenceSchema, resultSchema, type ExtractionResult } from "./contracts";

export const result: ExtractionResult = {
  version: 1, sourceSha256: "a".repeat(64), method: "native", manifest: { worker: "synthetic" }, elapsedMs: 10,
  pages: [{ page: 1, text: "Jane Example glucose 100 mg/dL", words: [], tables: [], figures: [], foregroundCoverage: null,
    redaction: { rules: [], openmed: [{ start: 0, end: 12, label: "NAME" }], combined: [{ start: 0, end: 12, label: "NAME" }], text: "[REDACTED] glucose 100 mg/dL" } }],
  totalPages: 1, summary: "Glucose was 100 mg/dL.", summaryStatus: "accepted", ageAtEncounter: null, measurements: [], warnings: [],
};
describe("extraction benchmark semantics", () => {
  it("does not confuse token coverage with ordering or quantitative correctness", () => {
    const reordered = textMetrics("100 glucose", "glucose 100");
    expect(reordered.token.recall).toBe(1);
    expect(reordered.wordErrorRate).toBe(1);
    expect(textMetrics("glucose 10", "glucose 100").token.recall).toBe(.5);
  });
  it("counts repeated words and duplicate predictions only once per reference occurrence", () => {
    expect(textMetrics("test test test", "test").token).toMatchObject({ recall: 1, precision: 1 / 3 });
    expect(redactionMetrics("Jane Jane", [{ start: 0, end: 4, label: "NAME" }, { start: 5, end: 9, label: "NAME" }], "Jane", [{ start: 0, end: 4, label: "NAME" }])).toMatchObject({ recall: 1, precision: .5 });
  });
  it("supports Unicode scalar offsets and distinguishes missing reference labels from perfect scores", () => {
    expect(redactionMetrics("😀 Jane", [{ start: 2, end: 6, label: "NAME" }], "Jane", [{ start: 0, end: 4, label: "NAME" }]).recall).toBe(1);
    expect(textMetrics("", "").token.recall).toBeNull();
    const labels = referenceSchema.parse({ version: 1, split: "test", pages: [{ page: 1, text: result.pages[0].text, pii: [{ start: 0, end: 12, label: "NAME" }] }], measurements: [], measurementsComplete: false });
    const score = benchmark(result, labels);
    expect(score.measurements).toBeNull(); expect(score.split).toBe("test");
    expect(score.pages[0].redaction.rules.recall).toBe(0);
    expect(score.pages[0].redaction.combined.recall).toBe(1);
  });
  it("rejects incomplete runs and invalid offsets instead of calling them fully processed", () => {
    expect(resultSchema.safeParse({ ...result, totalPages: 2 }).success).toBe(false);
    expect(referenceSchema.safeParse({ version: 1, split: "train", pages: [{ page: 1, text: "short", pii: [{ start: 0, end: 99, label: "NAME" }] }], measurements: [], measurementsComplete: false }).success).toBe(false);
  });
  it("preserves meaningful unit case and rejects unsupported measurement fields", () => {
    const measurement = { page: 1, name: "glucose", value: "100", unit: "mg/dL", date: "", range: "", evidence: "glucose 100 mg/dL" };
    expect(resultSchema.safeParse({ ...result, measurements: [measurement] }).success).toBe(true);
    expect(resultSchema.safeParse({ ...result, measurements: [{ ...measurement, unit: "mmol/L" }] }).success).toBe(false);
    const labels = referenceSchema.parse({ version: 1, split: "validation", pages: [{ page: 1, text: result.pages[0].text, pii: [] }], measurements: [{ ...measurement, unit: "Mg/dL" }], measurementsComplete: true });
    expect(benchmark({ ...result, measurements: [measurement] }, labels).measurements?.recall).toBe(0);
  });
});
