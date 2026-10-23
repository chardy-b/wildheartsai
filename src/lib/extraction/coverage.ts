import type { ExtractionResult } from "./contracts";

export type CoverageBox = [number, number, number, number];
export type CoverageRun = { id: string; method: string; result: ExtractionResult | null };
export type CoveragePage = {
  page: number; status: "measured" | "missing" | "incompatible";
  foreground: number; text: number; identified: number; unclassified: number;
  uncovered: CoverageBox[];
};
export type CoverageSummary = {
  totalPages: number; measuredPages: number; blankPages: number;
  textCoverage: number | null; identifiedCoverage: number | null; unclassifiedCoverage: number | null;
  methods: string[];
};
export type DocumentCoverage = CoverageSummary & { pages: CoveragePage[] };

function paint(mask: Uint8Array, width: number, height: number, boxes: CoverageBox[]) {
  for (const [x, y, r, b] of boxes) {
    const left = Math.max(0, Math.floor(x * width)), top = Math.max(0, Math.floor(y * height));
    const right = Math.min(width, Math.ceil(r * width)), bottom = Math.min(height, Math.ceil(b * height));
    for (let row = top; row < bottom; row++) mask.fill(1, row * width + left, row * width + right);
  }
}

// A scan or a whole-image upload is not a recognized illustration just because it
// is stored as one big raster. Native embedded figures on text pages are usable.
type ImageEvidence = Pick<ExtractionResult["pages"][number], "text" | "words" | "figures"> & Partial<Pick<ExtractionResult["pages"][number], "diagnostics" | "layoutRegions">>;
export function recognizedImages(page: ImageEvidence, method: string): CoverageBox[] {
  const nativeText = method === "native" && !page.diagnostics?.scanLike && page.text.trim().length >= 40 && page.words.length > 0;
  return [
    ...page.figures.filter(f => f.origin !== "unknown" || nativeText && (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]) < .8).map(f => f.box),
    ...(page.layoutRegions ?? []).filter(r => r.kind === "image" && r.origin !== "unknown").map(r => r.box),
  ];
}

// Latest completed run per method is selected by the caller. Never average
// percentages or union per-method gaps: classify the union of observed geometry.
export function combinedCoverage(runs: CoverageRun[]): DocumentCoverage {
  const available = runs.filter((run): run is CoverageRun & { result: ExtractionResult } => run.result !== null);
  const totalPages = Math.max(0, ...available.map(run => run.result.totalPages));
  const pages: CoveragePage[] = [];
  for (let number = 1; number <= totalPages; number++) {
    const pageRuns = available.flatMap(run => {
      const page = run.result.pages.find(p => p.page === number);
      return page ? [{ page, method: run.method, source: run.result.sourceSha256 }] : [];
    });
    const masks = pageRuns.flatMap(({ page }) => page.diagnostics?.foregroundMask ? [page.diagnostics.foregroundMask] : []);
    const raster = masks[0];
    const empty: CoveragePage = { page: number, status: "missing", foreground: 0, text: 0, identified: 0, unclassified: 0, uncovered: [] };
    if (!raster) { pages.push(empty); continue; }
    if (new Set(pageRuns.map(p => p.source)).size !== 1 || masks.some(m => m.width !== raster.width || m.height !== raster.height || m.bits !== raster.bits)) {
      pages.push({ ...empty, status: "incompatible" }); continue;
    }
    const { width, height } = raster, length = width * height;
    const bits = atob(raster.bits), textMask = new Uint8Array(length), imageMask = new Uint8Array(length);
    for (const { page, method } of pageRuns) {
      // Docling's block boxes cannot establish tight text coverage.
      if (method !== "docling") paint(textMask, width, height, page.words.map(w => w.box));
      paint(imageMask, width, height, recognizedImages(page, method));
      if (page.nativeAttempt?.status === "completed") {
        paint(textMask, width, height, page.nativeAttempt.words.map(w => w.box));
        paint(imageMask, width, height, recognizedImages(page.nativeAttempt, "native"));
      }
    }
    let foreground = 0, text = 0, identified = 0;
    const missing = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      if (!(bits.charCodeAt(i >> 3) & (1 << (i & 7)))) continue;
      foreground++;
      if (textMask[i]) text++;
      if (textMask[i] || imageMask[i]) identified++; else missing[i] = 1;
    }
    // Connected components give review targets on this page, rather than huge
    // tiles that also highlight content another method captured. Tiny gaps count
    // in the percentage too; components are bounded by the 200x200 sample.
    let uncovered: CoverageBox[] = [];
    const stack: number[] = [];
    for (let start = 0; start < length; start++) {
      if (!missing[start]) continue;
      missing[start] = 0; stack.push(start);
      let left = width, right = 0, top = height, bottom = 0;
      while (stack.length) {
        const i = stack.pop()!, x = i % width, y = Math.floor(i / width);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (const next of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, y > 0 ? i - width : -1, y + 1 < height ? i + width : -1]) {
          if (next >= 0 && missing[next]) { missing[next] = 0; stack.push(next); }
        }
      }
      uncovered.push([left / width, top / height, (right + 1) / width, (bottom + 1) / height]);
    }
    if (uncovered.length > 400) {
      const tiles = new Map<string, CoverageBox>();
      for (const box of uncovered) {
        const key = `${Math.min(19, Math.floor(box[0] * 20))}:${Math.min(19, Math.floor(box[1] * 20))}`;
        const previous = tiles.get(key);
        tiles.set(key, previous ? [Math.min(previous[0], box[0]), Math.min(previous[1], box[1]), Math.max(previous[2], box[2]), Math.max(previous[3], box[3])] : box);
      }
      uncovered = [...tiles.values()];
    }
    uncovered.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    pages.push({ page: number, status: "measured", foreground, text, identified, unclassified: foreground - identified, uncovered });
  }
  const measured = pages.filter(p => p.status === "measured");
  const foreground = measured.reduce((sum, p) => sum + p.foreground, 0);
  const complete = totalPages > 0 && measured.length === totalPages && foreground > 0;
  const ratio = (key: "text" | "identified" | "unclassified") => complete ? measured.reduce((sum, p) => sum + p[key], 0) / foreground : null;
  return { totalPages, measuredPages: measured.length, blankPages: measured.filter(p => p.foreground === 0).length,
    textCoverage: ratio("text"), identifiedCoverage: ratio("identified"), unclassifiedCoverage: ratio("unclassified"),
    methods: [...new Set(available.map(r => r.method))], pages };
}
