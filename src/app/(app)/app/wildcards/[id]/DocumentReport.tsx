"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { WildcardFile } from "@/lib/wildcards";
import type { ExtractionResult } from "@/lib/extraction/contracts";
import { coveragePercent, coverageSummary, extractionMethod, statusLabel, warningLabel, type ProgressItem } from "@/lib/extraction/presentation";
import { DocumentMarkdown } from "../DocumentMarkdown";

type Run = ProgressItem & { createdAt: string; result: ExtractionResult | null };
function ExtractedContent({ text, initialOpen = false }: { text: string; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return <details open={open} onToggle={e => setOpen(e.currentTarget.open)}><summary>Read redacted extracted content</summary>{open && <><DocumentMarkdown text={text} structure /><details><summary>Plain extracted text</summary><pre className="document-plain-text">{text}</pre></details></>}</details>;
}
export function DocumentReport({ file }: { file: WildcardFile }) {
  const [runs, setRuns] = useState<Run[] | null>(null), [selected, setSelected] = useState("");
  const [loaded, setLoaded] = useState<Run | null>(null), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch(`/api/extraction?fileId=${file.id}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error();
        const data: { runs: Run[] } = await response.json();
        if (controller.signal.aborted) return;
        setRuns(data.runs); setSelected(current => current || data.runs.find(r => r.status === "completed")?.id || "");
      } catch { if (!controller.signal.aborted) setError("Could not refresh extraction progress. Reload to try again."); }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [file.id]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/extraction?fileId=${file.id}&resultId=${selected}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error();
        const data: { runs: Run[] } = await response.json();
        if (!controller.signal.aborted) { setLoaded(data.runs.find(r => r.id === selected) ?? null); setError(""); }
      } catch { if (!controller.signal.aborted) setError("Could not load this report. Reload to try again."); }
    }
    void load(); return () => controller.abort();
  }, [file.id, selected]);
  const result = loaded?.id === selected ? loaded.result : null;
  const coverage = result ? coverageSummary(result) : null;
  return <section className="document-report" aria-label="Extraction report"><h2>Extraction report</h2>
    {error && <p role="alert">{error}</p>}
    {!runs ? <p role="status">Loading extraction progress…</p> : runs.length === 0 ? <p>No extraction has been queued for this document. The original is available below.</p> : <>
      <p>Latest run: <strong>{statusLabel(runs[0].status)}</strong> · requested method {runs[0].method}{runs[0].status === "queued" && runs[0].errorCode ? ` · Retry after ${new Date(runs[0].nextAttemptAt).toLocaleString()}` : ""}. Status refreshes every 10 seconds.</p>
      {runs.some(r => r.status === "completed") && <label>Report version <select value={selected} onChange={e => setSelected(e.target.value)}>{runs.filter(r => r.status === "completed").map(r => <option key={r.id} value={r.id}>{r.method} · {new Date(r.createdAt).toLocaleString()}</option>)}</select></label>}
    </>}
    <p><Link href="/app/wildcards/progress">All document progress</Link> · <Link href={`/app/wildcards/workbench?fileId=${file.id}`}>Queue a method or compare results</Link></p>
    {selected && !result && !error && <p role="status">Loading report…</p>}
    {result && coverage && <>
      <dl className="document-report-facts"><div><dt>How the text was obtained</dt><dd>{extractionMethod(result.method, file.type, result.manifest.pipeline)}{file.type.startsWith("text/") && <small>Requested comparison method: {result.method}; text uploads bypass OCR.</small>}</dd></div>
        <div><dt>Text availability</dt><dd>{coverage.pagesWithText} of {coverage.totalPages} {file.type.startsWith("text/") ? "text sections" : "pages"} contain extracted text</dd></div>
        <div><dt>Content recall / accuracy</dt><dd>Not measured against a reviewed reference</dd></div>
        <div><dt>Processing time</dt><dd>{(result.elapsedMs / 1000).toFixed(1)} seconds</dd></div>
        <div><dt>Summary privacy processing</dt><dd>Rules + local OpenMed · names and birthdates removed where detected · final identifier check</dd></div>
      </dl>
      <section><h3>Key information</h3>{result.summaryStatus === "accepted" ? <DocumentMarkdown text={result.summary} /> : <p>No summary is available for this run. Check the review notes below.</p>}
        <p>Age at encounter: {result.ageAtEncounter ?? "Omitted — insufficient date evidence"}</p><p className="document-report-note">Machine-extracted information; verify it against the original.</p></section>
      {result.warnings.length > 0 && <section className="document-review-notes"><h3>Review notes</h3><ul>{result.warnings.map(w => <li key={w}>{warningLabel(w)}</li>)}</ul></section>}
      <section><h3>Structured measurements ({result.measurements.length})</h3><p><Link href={`/app/wildcards/${file.id}/fhir?runId=${selected}`}>View this extraction as FHIR / Medplum data</Link></p>{result.measurements.length === 0 ? <p>No validated measurement candidates were saved. This does not establish that the document contains no measurements.</p> : <div className="wildcard-table-wrap"><table className="wildcard-table"><caption className="sr-only">Extracted quantitative measurements with source evidence</caption><thead><tr><th>Measurement</th><th>Value</th><th>Unit</th><th>Date</th><th>Reference range</th><th>Source</th></tr></thead><tbody>{result.measurements.map((m, i) => <tr key={i}><th scope="row">{m.name}</th><td>{m.value}</td><td>{m.unit || "Not stated"}</td><td>{m.date || "Not stated"}</td><td>{m.range || "Not stated"}</td><td><a href={`#extracted-page-${m.page}`}>Page {m.page}</a><details><summary>Private source quotation</summary><p>{m.evidence}</p></details></td></tr>)}</tbody></table></div>}</section>
      <section><h3>Coverage and extracted content</h3><p>{file.type.startsWith("text/") ? "Visual coverage does not apply to text uploads. The file was read directly as UTF-8; completeness has not been independently verified." : "Visual coverage estimates the percentage of non-white page pixels inside extracted word boxes. Figures, rules, and scan backgrounds count too. It is not the percentage of correct text, and a document-wide recall score requires reviewed reference labels."}</p>
        {result.pages.map(p => <section key={p.page} id={`extracted-page-${p.page}`} className="document-source-page"><h4>{file.type.startsWith("text/") ? "Text section" : "Page"} {p.page}</h4><p>Visual coverage: <strong>{file.type.startsWith("text/") ? "Not applicable" : coveragePercent(p.foregroundCoverage)}</strong>{p.foregroundCoverage === null && !file.type.startsWith("text/") ? " — no usable word geometry for this estimate" : ""} · {p.tables.length} detected tables · {p.figures.length} image regions</p>
          {p.foregroundCoverage !== null && !file.type.startsWith("text/") && <meter min={0} max={1} value={p.foregroundCoverage} aria-label={`Page ${p.page} visual coverage`}>{coveragePercent(p.foregroundCoverage)}</meter>}
          <p>Text source: {p.diagnostics?.textSource ?? "Direct text"}{p.fallbackReason ? ` · OCR fallback: ${p.fallbackReason.replaceAll("_", " ")}` : ""}</p>
          <ExtractedContent text={p.redaction.text} initialOpen={p.page === 1} />
          {p.nativeAttempt && <details><summary>Native result before OCR · {p.nativeAttempt.status}</summary><ExtractedContent text={p.nativeAttempt.redaction.text} /><p>{p.nativeAttempt.tables.length} native tables · {p.nativeAttempt.words.length} native word boxes retained</p></details>}
          {p.figures.length > 0 && <details><summary>Detected images and captions</summary><ul>{p.figures.map((figure, i) => <li key={i}>{figure.caption || "No caption available"} · annotation source: {figure.origin}</li>)}</ul></details>}
        </section>)}
      </section>
      <details><summary>Model and tool provenance</summary><p>Run {loaded?.id} · {new Date(loaded!.createdAt).toLocaleString()}</p><dl>{Object.entries(result.manifest).map(([name, value]) => <div key={name}><dt>{name.replaceAll("_", " ")}</dt><dd>{value}</dd></div>)}</dl></details>
    </>}
  </section>;
}
