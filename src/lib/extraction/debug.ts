import type { ExtractionResult } from "./contracts";

type Box = [number, number, number, number];
export type DebugRun = { id: string; method: string; result: ExtractionResult | null };
export type EvidenceWord = { text: string; box: Box; confidence?: number; sources: string[]; alternatives: { text: string; source: string }[] };
export type DebugOverlay = { box: Box; label: string; color?: string };
const palette = ["#2563eb", "#059669", "#9333ea", "#0891b2"];
const normalize = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();
function overlap(a: Box, b: Box) {
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return intersection / Math.max(1e-9, Math.min((a[2]-a[0])*(a[3]-a[1]), (b[2]-b[0])*(b[3]-b[1])));
}
// Spatial buckets bound candidate work; disagreement preserves case-sensitive clinical units.
export function combinedEvidence(runs: DebugRun[], page: number) {
  const words: EvidenceWord[] = [], buckets = new Map<string, number[]>();
  for (const run of runs) for (const word of run.result?.pages.find(p => p.page === page)?.words ?? []) {
    const [x,y,r,b] = word.box, keys: string[] = [];
    for (let row=Math.floor(y*20);row<=Math.min(19,Math.floor(b*20));row++) for(let col=Math.floor(x*20);col<=Math.min(19,Math.floor(r*20));col++) keys.push(`${row}:${col}`);
    const candidates = new Set(keys.flatMap(k => buckets.get(k) ?? []));
    const index = [...candidates].find(i => !words[i].sources.includes(run.id) && overlap(words[i].box, word.box) >= .55 && !/\s/.test(normalize(word.text)) && !/\s/.test(normalize(words[i].text)));
    if (index !== undefined) {
      const existing = words[index]; existing.sources.push(run.id);
      if (normalize(existing.text) !== normalize(word.text)) existing.alternatives.push({ text: word.text, source: run.id });
      continue;
    }
    const next = words.length;
    words.push({ ...word, sources: [run.id], alternatives: [] });
    for (const k of keys) { const values=buckets.get(k) ?? []; values.push(next); buckets.set(k,values); }
  }
  return words;
}
export function debugOverlays(runs: DebugRun[], page: number, source: string, layer: string, threshold = .7) {
  const selected = source === "combined" ? runs : runs.filter(r => r.id === source);
  const overlays: DebugOverlay[] = [];
  if (layer === "disagreements") {
    for (const w of combinedEvidence(runs,page)) if(w.alternatives.length) overlays.push({ box:w.box,label:"Methods disagree here; review original",color:"#dc2626" });
  } else for (const [index,run] of selected.entries()) {
    const p=run.result?.pages.find(p=>p.page===page); if(!p) continue;
    const color=palette[index%palette.length];
    if(layer==="words" || layer==="low-confidence") for(const w of p.words) {
      if(layer==="low-confidence" && (w.confidence===undefined || w.confidence>=threshold)) continue;
      overlays.push({box:w.box,label:layer==="low-confidence" ? `${run.method}: confidence ${(100*w.confidence!).toFixed(0)}%; not calibrated accuracy` : `${run.method}: extracted geometry`,color:layer==="low-confidence" ? "#d97706" : color});
    }
    if(layer==="uncovered") for(const region of p.diagnostics?.uncoveredRegions ?? []) overlays.push({box:region.box,label:`${run.method}: uncovered foreground; may be a figure, rule, or missed text`,color:"#dc2626"});
    if(layer==="layout") {
      for(const region of p.layoutRegions ?? []) overlays.push({box:region.box,label:`${run.method}: ${region.kind} region`,color});
      for(const figure of p.figures) overlays.push({box:figure.box,label:`${run.method}: image region; interpretation unverified`,color:"#9333ea"});
    }
  }
  return { overlays: overlays.slice(0,4000), total: overlays.length, displayed:Math.min(overlays.length,4000) };
}
