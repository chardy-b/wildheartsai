import { describe, expect, it } from "vitest";
import { combinedCoverage, type CoverageRun } from "./coverage";
import { resultSchema, type ExtractionResult } from "./contracts";

function run(method: string, words: [number, number, number, number][] = [], bits = 15): CoverageRun {
  const page = { page: 1, text: "A synthetic document with sufficiently long embedded text", words: words.map(box => ({ box, text: "word" })), tables: [], figures: [], foregroundCoverage: null,
    redaction: { rules: [], openmed: [], combined: [], text: "Synthetic" },
    diagnostics: { version: 1, textSource: method, foregroundPixels: 4, coveredForegroundPixels: 0, sampleWidth: 4, sampleHeight: 1,
      uncoveredRegions: [], lowConfidenceWords: 0, confidenceWords: 0, imageRegions: 0,
      foregroundMask: { width: 4, height: 1, bits: Buffer.from([bits]).toString("base64") } } } satisfies ExtractionResult["pages"][number];
  return { id: method, method, result: { version: 1, method: "native", sourceSha256: "a".repeat(64), manifest: {}, elapsedMs: 0, totalPages: 1,
    pages: [page], summary: "", summaryStatus: "withheld", ageAtEncounter: null, measurements: [], warnings: [] } };
}

describe("combined document coverage", () => {
  it("unions captured text and images, leaving only unidentified ink", () => {
    const native = run("native", [[0, 0, .25, 1]]), ocr = run("tesseract", [[.25, 0, .5, 1]]);
    native.result!.pages[0].figures.push({ box: [.5, 0, .75, 1], caption: "", origin: "vision" });
    const value = combinedCoverage([native, ocr]);
    expect(value).toMatchObject({ textCoverage: .5, identifiedCoverage: .75, unclassifiedCoverage: .25, measuredPages: 1 });
    expect(value.pages[0].uncovered).toEqual([[.75, 0, 1, 1]]);
  });
  it("counts overlapping boxes once and lets a second method fill a gap", () => {
    expect(combinedCoverage([run("native", [[0, 0, .5, 1]]), run("tesseract", [[0, 0, .5, 1]])]).textCoverage).toBe(.5);
    const value = combinedCoverage([run("native", [[0, 0, .5, 1]]), run("tesseract", [[.5, 0, 1, 1]])]);
    expect(value.unclassifiedCoverage).toBe(0); expect(value.pages[0].uncovered).toEqual([]);
  });
  it("does not treat a full scan or Docling block as recognized content", () => {
    const scan = run("native");
    scan.result!.pages[0].figures.push({ box: [0, 0, 1, 1], caption: "", origin: "unknown" });
    expect(combinedCoverage([scan, run("docling", [[0, 0, 1, 1]])]).unclassifiedCoverage).toBe(1);
  });
  it("counts embedded native images on text pages, but excludes whole-page rasters", () => {
    const native = run("native", [[0, 0, .25, 1]]);
    native.result!.pages[0].figures.push({ box: [.25, 0, .5, 1], caption: "", origin: "unknown" });
    expect(combinedCoverage([native]).identifiedCoverage).toBe(.5);
    native.result!.pages[0].figures[0].box = [0, 0, 1, 1];
    expect(combinedCoverage([native]).identifiedCoverage).toBe(.25);
  });
  it("excludes white space and avoids claiming 100 percent on blank documents", () => {
    const value = combinedCoverage([run("tesseract", [[0, 0, .25, 1]], 1)]);
    expect(value.identifiedCoverage).toBe(1);
    const blank = combinedCoverage([run("native", [], 0)]);
    expect(blank.identifiedCoverage).toBeNull(); expect(blank.blankPages).toBe(1); expect(blank.pages[0].uncovered).toEqual([]);
  });
  it("includes retained native evidence when native-first processing falls back to OCR", () => {
    const source = run("native", [[.5, 0, 1, 1]]);
    source.result!.pages[0].nativeAttempt = {
      status: "completed", text: "Retained native text", words: [{ text: "retained", box: [0, 0, .5, 1] }],
      tables: [], figures: [], redaction: { rules: [], openmed: [], combined: [], text: "Retained native text" },
    };
    expect(combinedCoverage([source]).textCoverage).toBe(1);
    source.result!.pages[0].nativeAttempt!.status = "failed";
    expect(combinedCoverage([source]).textCoverage).toBe(.5);
  });
  it("keeps older, partial and incompatible renders unmeasured", () => {
    const old = run("native"); delete old.result!.pages[0].diagnostics!.foregroundMask;
    expect(combinedCoverage([old]).measuredPages).toBe(0);
    expect(combinedCoverage([old, run("tesseract")]).measuredPages).toBe(1);
    const partial = run("native"); partial.result!.totalPages = 2;
    expect(combinedCoverage([partial]).identifiedCoverage).toBeNull();
    expect(combinedCoverage([run("native"), run("tesseract", [], 3)]).pages[0].status).toBe("incompatible");
    const changed = run("tesseract"); changed.result!.sourceSha256 = "b".repeat(64);
    expect(combinedCoverage([run("native"), changed]).pages[0].status).toBe("incompatible");
  });
  it("weights document percentages by non-white sample pixels, not page means", () => {
    const source = run("native", [[0, 0, .5, 1]]);
    source.result!.totalPages = 2;
    source.result!.pages.push({ ...run("native", [], 1).result!.pages[0], page: 2 });
    expect(combinedCoverage([source]).textCoverage).toBe(.4);
  });
  it("bounds and validates masks at the worker boundary while accepting old runs", () => {
    const source = run("native");
    expect(resultSchema.safeParse(source.result).success).toBe(true);
    source.result!.pages[0].diagnostics!.foregroundMask!.bits = "/////w==";
    expect(resultSchema.safeParse(source.result).success).toBe(false);
    delete source.result!.pages[0].diagnostics!.foregroundMask;
    expect(resultSchema.safeParse(source.result).success).toBe(true);
  });
});
