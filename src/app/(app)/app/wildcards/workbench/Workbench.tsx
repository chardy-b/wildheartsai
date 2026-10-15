"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WildcardFile } from "@/lib/wildcards";
import { METHODS, referenceSchema, type ExtractionResult, type Reference } from "@/lib/extraction/contracts";
import { benchmark } from "@/lib/extraction/metrics";
import { FileViewer } from "../[id]/FileViewer";
import { DocumentMarkdown } from "../DocumentMarkdown";

type Run = { id: string; fileId: string; method: string; status: string; createdAt: string; attempts: number; nextAttemptAt: string; errorCode: string | null; result: ExtractionResult | null };
type Labels = { id: string; createdAt: string; labels: Reference | null };
const percent = (n: number | null | undefined) => n == null ? "Unscored" : `${(n * 100).toFixed(1)}%`;

export function Workbench({ files, initialFileId }: { files: WildcardFile[]; initialFileId?: string }) {
  const startingFile = files.find(f => f.id === initialFileId) ?? files[0];
  const [fileId, setFileId] = useState(startingFile?.id ?? "");
  const activeFile = useRef(startingFile?.id ?? "");
  const [selected, setSelected] = useState<string[]>(startingFile ? [startingFile.id] : []);
  const [methods, setMethods] = useState<string[]>(["native", "tesseract"]);
  const [date, setDate] = useState("");
  const [runs, setRuns] = useState<Run[]>([]), [labels, setLabels] = useState<Labels[]>([]);
  const [compared, setCompared] = useState<Run[]>([]);
  const [available, setAvailable] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [enabledMethods, setEnabledMethods] = useState<string[]>(["native", "tesseract"]);
  const [page, setPage] = useState(1), [referenceId, setReferenceId] = useState("");
  const [draft, setDraft] = useState(""), [showRaw, setShowRaw] = useState(false);
  const [piiLabel, setPiiLabel] = useState("NAME"), [selection, setSelection] = useState<[number, number]>([0, 0]);
  let draftReference: Reference | null = null;
  try { const parsed = referenceSchema.safeParse(JSON.parse(draft)); if (parsed.success) draftReference = parsed.data; } catch { /* JSON editor can be temporarily incomplete. */ }
  const draftPage = draftReference?.pages?.find(p => p.page === page);
  const file = files.find(f => f.id === fileId);
  const reference = labels.find(r => r.id === referenceId);
  const referenceLabels = reference?.labels;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!fileId) return;
    const response = await fetch(`/api/extraction?fileId=${fileId}${referenceId ? `&referenceId=${referenceId}` : ""}`, { cache: "no-store", signal });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (signal?.aborted || activeFile.current !== fileId) return;
    setRuns(data.runs); setLabels(data.references); setAvailable(data.available); setEnabledMethods(data.methods);
  }, [fileId, referenceId]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = () => { if (active) void refresh(controller.signal).catch(() => { if (active) setMessage("Could not load runs. Refresh to try again."); }); };
    load(); const timer = setInterval(load, 10_000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [refresh]);
  async function mutate(method: string, input: unknown) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/extraction", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error();
      await refresh(); setMessage(method === "PUT" ? "Saved a new reference version." : method === "DELETE" ? "Run cancelled." : "Runs queued on the private document worker.");
    } catch { setMessage("Request failed. Check the worker configuration and inputs, then try again."); }
    finally { setBusy(false); }
  }
  async function compare(run: Run) {
    if (compared.some(r => r.id === run.id)) { setCompared(rows => rows.filter(r => r.id !== run.id)); return; }
    if (compared.length >= 3) { setMessage("Compare up to three runs at once."); return; }
    try {
      const response = await fetch(`/api/extraction?fileId=${fileId}&resultId=${run.id}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (activeFile.current !== fileId) return;
      const found = data.runs.find((r: Run) => r.id === run.id);
      if (found?.result) setCompared(rows => rows.some(r => r.id === found.id) ? rows : [...rows, found]);
    } catch { setMessage("Could not load this result."); }
  }
  function seedReference() {
    const result = compared[0]?.result;
    const p = result?.pages.find(p => p.page === page);
    setDraft(JSON.stringify({ version: 1, split: "train", pages: [{ page, text: p?.text ?? "", pii: [] }], measurements: [], measurementsComplete: false }, null, 2));
    setMessage("This is an unreviewed draft. Correct it against the original, add PII spans, and include every measurement before marking measurementsComplete.");
  }
  function saveLabels() {
    try { const parsed = referenceSchema.parse(JSON.parse(draft)); void mutate("PUT", { fileId, labels: parsed }); }
    catch { setMessage("Reference JSON is invalid. Check fields and Unicode character offsets."); }
  }
  function markSelection() {
    if (!draftReference || !draftPage || selection[0] === selection[1]) return;
    const start = Array.from(draftPage.text.slice(0, selection[0])).length, end = Array.from(draftPage.text.slice(0, selection[1])).length;
    const updated = { ...draftReference, pages: draftReference.pages.map(p => p.page === page ? { ...p, pii: [...p.pii, { start, end, label: piiLabel }] } : p) };
    setDraft(JSON.stringify(updated, null, 2));
  }
  function exportScores() {
    if (!reference || !referenceLabels) return;
    const report = { version: 1, referenceId: reference.id, split: referenceLabels.split, runs: compared.filter(r => r.result).map(r => ({ id: r.id, method: r.method, manifest: r.result!.manifest, elapsedMs: r.result!.elapsedMs, warnings: r.result!.warnings, score: benchmark(r.result!, referenceLabels) })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "extraction-benchmark.json"; anchor.click(); URL.revokeObjectURL(url);
  }
  if (!files.length) return <p>Upload a document to begin.</p>;
  return <div className="extraction-workbench">
    <fieldset><legend>Experiment</legend>
      {!available && <p role="status">Workers are not configured for this deployment. You can inspect stored results and label references.</p>}
      <label>Documents to process<select multiple value={selected} onChange={e => setSelected([...e.target.selectedOptions].map(o => o.value))}>{files.map(f => <option key={f.id} value={f.id}>{f.relativePath ?? f.name}</option>)}</select></label>
      <div className="workbench-methods">{METHODS.map(m => <label key={m}><input type="checkbox" disabled={!enabledMethods.includes(m)} checked={methods.includes(m)} onChange={e => setMethods(rows => e.target.checked ? [...rows, m] : rows.filter(v => v !== m))} />{m}{!enabledMethods.includes(m) ? " (not configured)" : ""}</label>)}</div>
      <label>Encounter date for age calculation (optional)<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      <p>Without an encounter date, birthdate is removed and age is omitted. All methods include rules/OpenMed/combined redaction comparisons.</p>
      <button disabled={busy || !available || !selected.length || !methods.length} onClick={() => void mutate("POST", { fileIds: selected, methods, ...(date ? { encounterDate: date } : {}) })}>Run comparison</button>
    </fieldset>
    {message && <p role="status">{message}</p>}
    <label>Inspect document<select disabled={busy} value={fileId} onChange={e => { activeFile.current = e.target.value; setFileId(e.target.value); setCompared([]); setRuns([]); setLabels([]); setReferenceId(""); setPage(1); setDraft(""); setShowRaw(false); }}>{files.map(f => <option key={f.id} value={f.id}>{f.relativePath ?? f.name}</option>)}</select></label>
    <div className="workbench-table"><table><thead><tr><th>Method</th><th>Created</th><th>Status</th><th>Actions</th></tr></thead><tbody>{runs.map(r => <tr key={r.id}><td>{r.method}</td><td>{new Date(r.createdAt).toLocaleString()}</td><td>{r.status}{r.errorCode ? ` (${r.errorCode})` : ""}{r.attempts > 0 && <small> · {r.attempts} attempts</small>}{r.status === "queued" && r.errorCode && <small> · Retry after {new Date(r.nextAttemptAt).toLocaleString()}</small>}</td><td>{r.status === "completed" ? <button onClick={() => void compare(r)}>{compared.some(c => c.id === r.id) ? "Remove" : "Compare"}</button> : ["queued", "running", "recovering"].includes(r.status) ? <button disabled={busy} onClick={() => void mutate("DELETE", { id: r.id })}>Cancel</button> : null}</td></tr>)}</tbody></table></div>
    <label>Reference version<select value={referenceId} onChange={e => setReferenceId(e.target.value)}><option value="">No reference — coverage estimates only</option>{labels.map(r => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString()} · {r.labels?.split ?? "reference"} · {r.id.slice(0, 8)}</option>)}</select></label>
    <button disabled={!referenceLabels || !compared.length} onClick={exportScores}>Export benchmark scores</button>
    <label><input type="checkbox" checked={showRaw} onChange={e => setShowRaw(e.target.checked)} />Show private raw text (may contain identifiers)</label>
    <div className="workbench-comparison">
      <article><h2>Original</h2>{file && <FileViewer key={file.id} file={file} onPageChange={setPage} overlays={compared[0]?.result?.pages.find(p => p.page === page)?.words.map(w => ({ box: w.box, label: "Extracted word" }))} />}</article>
      {compared.map(r => {
        const result = r.result!, p = result.pages.find(p => p.page === page), score = referenceLabels ? benchmark(result, referenceLabels) : null, ps = score?.pages.find(p => p.page === page);
        return <article key={r.id}><h2>{r.method}</h2><p>{(result.elapsedMs / 1000).toFixed(1)} seconds · {result.totalPages} pages</p>
          <p>Foreground covered by extracted word boxes: {percent(p?.foregroundCoverage)}. This estimates visual coverage, not accuracy.</p>
          {ps && <><p>Token precision {percent(ps.text.token.precision)} · recall {percent(ps.text.token.recall)} · word error {percent(ps.text.wordErrorRate)}</p>
            <table><thead><tr><th>PII detector</th><th>Precision</th><th>Recall</th></tr></thead><tbody>{Object.entries(ps.redaction).map(([name, s]) => <tr key={name}><td>{name}</td><td>{percent(s.precision)}</td><td>{percent(s.recall)}</td></tr>)}</tbody></table></>}
          {score && <><p>Reviewed pages: {score.labeledPages} of {score.totalPages}. Token recall across reviewed pages: {percent(score.textToken.recall)}.</p><p>Measurement precision {percent(score.measurements?.precision)} · recall {percent(score.measurements?.recall)}</p><p>Known identifier matches in summary: {score.summaryLeakedGoldSpans ?? "Unscored"} · Age: {score.ageCorrect === null ? "Unscored" : score.ageCorrect ? "Correct" : "Incorrect"}</p></>}
          <h3>Redacted summary</h3>{result.summaryStatus === "accepted" ? <DocumentMarkdown text={result.summary} /> : <p>Summary withheld; check the review flags.</p>}
          <p>Age at encounter: {result.ageAtEncounter ?? "Omitted — insufficient date evidence"}. Machine extraction; verify against the original.</p>
          <h3>Page {page} redacted text</h3><DocumentMarkdown text={p?.redaction.text ?? "No page"} />
          {showRaw && <><h3>Private extracted text</h3><pre>{p?.text}</pre><details><summary>Run manifest and raw result</summary><pre>{JSON.stringify(result, null, 2)}</pre></details></>}
          <details><summary>Structured measurements ({result.measurements.length})</summary><pre>{JSON.stringify(result.measurements, null, 2)}</pre></details>
          {result.warnings.length > 0 && <p>Review flags: {result.warnings.join(", ")}</p>}
        </article>;
      })}
    </div>
    <details><summary>Create a reviewed reference version</summary><p>Review against the original. PII spans use Unicode character offsets [start, end), labels NAME, DOB, ID, EMAIL, PHONE, ADDRESS, or DATE. Save separate train/validation/test versions; keep test labels out of tuning.</p>
      <button onClick={seedReference}>Start draft from current page</button>
      {draftPage && <><label>Correct reference text, then select an identifier<textarea rows={10} value={draftPage.text} spellCheck={false} onSelect={e => setSelection([e.currentTarget.selectionStart, e.currentTarget.selectionEnd])} onChange={e => {
        if (draftReference) setDraft(JSON.stringify({ ...draftReference, pages: draftReference.pages.map(p => p.page === page ? { ...p, text: e.target.value, pii: [] } : p) }, null, 2));
      }} /></label><p>Editing reference text clears its PII spans so offsets cannot silently become stale.</p><label>Identifier type<select value={piiLabel} onChange={e => setPiiLabel(e.target.value)}>{["NAME", "DOB", "ID", "EMAIL", "PHONE", "ADDRESS", "DATE"].map(label => <option key={label}>{label}</option>)}</select></label><button onClick={markSelection}>Mark selected identifier</button></>}
      <label>Reference JSON, including measurement labels and dataset split<textarea rows={22} value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false} /></label><button disabled={busy || !draft} onClick={saveLabels}>Save reviewed reference</button>
    </details>
  </div>;
}
