import type { ExtractionResult, PiiSpan, Reference } from "./contracts";

const normalize = (s: string) => s.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
function bag(items: string[]) { const counts = new Map<string, number>(); for (const s of items) counts.set(s, (counts.get(s) ?? 0) + 1); return counts; }
export function prf(tp: number, predicted: number, expected: number) {
  const precision = predicted ? tp / predicted : null;
  const recall = expected ? tp / expected : null;
  return { tp, predicted, expected, precision, recall, f1: precision !== null && recall !== null ? (precision + recall ? 2 * precision * recall / (precision + recall) : 0) : null };
}
export function textMetrics(actual: string, expected: string) {
  const a = normalize(actual).split(/\s+/).filter(Boolean), e = normalize(expected).split(/\s+/).filter(Boolean);
  const ac = bag(a), ec = bag(e);
  const tp = [...ec].reduce((n, [s, count]) => n + Math.min(count, ac.get(s) ?? 0), 0);
  // An explicit budget avoids quadratic work on large references. Unscored is not zero error.
  let wordErrorRate: number | null = null;
  if (e.length && a.length * e.length <= 4_000_000) {
    let previous = Array.from({ length: e.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= e.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== e[j - 1]));
      previous = row;
    }
    wordErrorRate = previous[e.length] / e.length;
  }
  return { token: prf(tp, a.length, e.length), wordErrorRate };
}
function spanSurfaces(text: string, spans: PiiSpan[]) {
  const chars = Array.from(text);
  return spans.map(s => `${s.label}:${normalize(chars.slice(s.start, s.end).join(""))}`);
}
export function redactionMetrics(actual: string, spans: PiiSpan[], expected: string, gold: PiiSpan[]) {
  // Surface multiset comparison works across different OCR offsets; report this matching rule.
  const a = bag(spanSurfaces(actual, spans)), e = bag(spanSurfaces(expected, gold));
  const tp = [...e].reduce((n, [s, count]) => n + Math.min(count, a.get(s) ?? 0), 0);
  return prf(tp, spans.length, gold.length);
}
const literal = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();
// Unit case is meaningful (mU and MU must never score as equivalent).
const measurementKey = (m: Reference["measurements"][number]) => JSON.stringify([m.page, normalize(m.name), ...[m.value, m.unit, m.date, m.range].map(literal)]);
function leakage(text: string, expected: string, spans: PiiSpan[]) {
  const normalized = normalize(text), chars = Array.from(expected);
  return spans.filter(s => {
    const value = normalize(chars.slice(s.start, s.end).join(""));
    return value.length >= 2 && normalized.includes(value);
  }).length;
}
export function benchmark(result: ExtractionResult, reference: Reference) {
  const pages = reference.pages.map(gold => {
    const p = result.pages.find(p => p.page === gold.page);
    return { page: gold.page, text: textMetrics(p?.text ?? "", gold.text), leakedGoldSpans: p ? leakage(p.redaction.text, gold.text, gold.pii) : null,
      redaction: Object.fromEntries((["rules", "openmed", "combined"] as const).map(method => [method, redactionMetrics(p?.text ?? "", p?.redaction[method] ?? [], gold.text, gold.pii)])) };
  });
  const pageIds = new Set(reference.pages.map(p => p.page));
  const actual = result.measurements.filter(m => pageIds.has(m.page));
  const a = bag(actual.map(measurementKey)), e = bag(reference.measurements.map(measurementKey));
  const tp = [...e].reduce((n, [s, count]) => n + Math.min(count, a.get(s) ?? 0), 0);
  const totals = (items: ReturnType<typeof prf>[]) => prf(items.reduce((n, v) => n + v.tp, 0), items.reduce((n, v) => n + v.predicted, 0), items.reduce((n, v) => n + v.expected, 0));
  return { referenceVersion: 1, split: reference.split, matching: "normalized token multiset; PII label + surface multiset; exact measurement tuple; leakage by normalized substring (review matches)", pages,
    labeledPages: reference.pages.length, totalPages: result.totalPages, allPagesReviewed: reference.pages.length === result.totalPages,
    textToken: totals(pages.map(p => p.text.token)),
    redaction: Object.fromEntries((["rules", "openmed", "combined"] as const).map(method => [method, totals(pages.map(p => p.redaction[method]))])),
    summaryLeakedGoldSpans: result.summaryStatus === "accepted" ? reference.pages.reduce((n, p) => n + leakage(result.summary, p.text, p.pii), 0) : null,
    ageCorrect: reference.expectedAgeAtEncounter === undefined ? null : result.ageAtEncounter === reference.expectedAgeAtEncounter,
    measurements: reference.measurementsComplete ? prf(tp, actual.length, reference.measurements.length) : null };
}
