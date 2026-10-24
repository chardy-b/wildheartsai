"use client";

import Link from "next/link";
import { useRef, useState, type ChangeEvent } from "react";
import type { DemoSnapshot } from "@/lib/demo/store";
import { DEMO_NAME, DEMO_PROMPTS, DEMO_RESEARCH, DEMO_SOURCES, demoDay } from "@/lib/demo/scenario";

const chapters = [
  { title: "Meet Alex", label: "One person. Many portals.", cue: "Introduce the case, then open the imported chart. Every patient, clinic and appointment is fictional." },
  { title: "Bring it together", label: "A connected story", cue: "Replay the sample sync, filter by clinic, and open a record. The main app's timeline can read these same encrypted records." },
  { title: "Ask Holo", label: "From records to understanding", cue: "Choose a prepared example for a reliable walkthrough. Open its evidence, then try the same question in live chat." },
  { title: "Add a document", label: "The missing piece", cue: "Download the sample PDF, upload it here, inspect its prepared extraction and FHIR mapping, then ask what it adds." },
  { title: "Prepare for care", label: "Ready for the next conversation", cue: "Show the upcoming visits, assemble a brief, and simulate a provider message. Messaging and email are mockups." },
  { title: "Check the evidence", label: "Understand why", cue: "Separate chart facts from general research. These two authored summaries link to real publications; they are a local demo library." },
] as const;
type RecordView = DemoSnapshot["records"][number];
type Prompt = typeof DEMO_PROMPTS[number];
function date(value: string) { return new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); }

async function demoApi(path: string, init?: RequestInit): Promise<DemoSnapshot> {
  const response = await fetch(`/api/demo/${path}`, { ...init, credentials: "same-origin", cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "The demo could not load. Try again.");
  return body;
}

export function DemoWorkspace({ initial }: { initial: DemoSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [chapter, setChapter] = useState(0);
  const [visited, setVisited] = useState<number[]>([0]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState<RecordView | null>(null);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [documentStage, setDocumentStage] = useState<"idle" | "review" | "saved">(initial.records.some(r => r.fhirId === "outside-report") ? "saved" : "idle");
  const [documentBytes, setDocumentBytes] = useState<ArrayBuffer | null>(null);
  const [messageMode, setMessageMode] = useState<"portal" | "email">("portal");
  const [draft, setDraft] = useState("Hello Dr. Park, my swallowing has improved, but bloating still affects several days each week. Could we review the maintenance plan and next steps for the remaining symptoms at my upcoming visit? I can bring my symptom diary and outside report.");
  const fileInput = useRef<HTMLInputElement>(null);
  const imported = snapshot.records.some(r => r.fhirId === "outside-report");
  const activeSources = snapshot.sources.filter(s => s.key !== "documents");
  const appointments = snapshot.records.filter(r => r.category === "appointment").sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const current = chapters[chapter];

  function navigate(index: number) { setChapter(index); setVisited(previous => previous.includes(index) ? previous : [...previous, index]); setEvidence(null); setError(""); setNotice(""); }
  function openEvidence(id: string) {
    const record = snapshot.records.find(r => r.fhirId === id);
    if (!record) { setNotice("Upload the provided sample PDF to add this record first."); return; }
    setEvidence(record);
    requestAnimationFrame(() => { const element = document.getElementById("demo-evidence"); element?.scrollIntoView({ behavior: "smooth", block: "nearest" }); element?.focus({ preventScroll: true }); });
  }
  async function runAction(action: "sync" | "reset") {
    setBusy(true); setError(""); setNotice("");
    try {
      setSnapshot(await demoApi(action, { method: "POST" }));
      if (action === "reset") { setChapter(0); setVisited([0]); setPrompt(null); setEvidence(null); setDocumentStage("idle"); setDocumentBytes(null); }
      setNotice(action === "sync" ? "Sample sync complete. All three fictional clinics are up to date. Repeated imports do not duplicate records." : "Fictional chart restored and tour restarted. Real accounts are unaffected.");
    } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function choosePdf(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 64000 || !file.name.toLowerCase().endsWith(".pdf")) { setError("Use the small sample PDF provided here. Other files can be processed through Documents."); return; }
    const input = event.target;
    setBusy(true); setError(""); setNotice("");
    try {
      const bytes = await file.arrayBuffer();
      const response = await fetch("/api/demo/sample.pdf", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not verify the sample. Try again.");
      const expected = new Uint8Array(await response.arrayBuffer()), actual = new Uint8Array(bytes);
      if (expected.length !== actual.length || !actual.every((value, index) => value === expected[index])) throw new Error("This is not the provided demo PDF. Use Documents for real extraction; no sample findings were created from this file.");
      setDocumentBytes(bytes); setDocumentStage("review");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read the file."); }
    finally { input.value = ""; setBusy(false); }
  }
  async function loadSample() {
    setBusy(true); setError("");
    try { const response = await fetch("/api/demo/sample.pdf", { cache: "no-store" }); if (!response.ok) throw new Error("Could not load the sample PDF."); setDocumentBytes(await response.arrayBuffer()); setDocumentStage("review"); }
    catch (e) { setError(e instanceof Error ? e.message : "Try again."); }
    finally { setBusy(false); }
  }
  async function mapDocument() {
    if (!documentBytes) return;
    setBusy(true); setError("");
    try { setSnapshot(await demoApi("document", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: documentBytes })); setDocumentStage("saved"); setNotice("Two sample FHIR records saved. They are now searchable here and in the main app's record tools."); }
    catch (e) { setError(e instanceof Error ? e.message : "Try again."); }
    finally { setBusy(false); }
  }
  function downloadBrief() {
    const brief = DEMO_PROMPTS.find(p => p.id === "visit")!;
    const blob = new Blob([`FICTIONAL DEMO — ${DEMO_NAME}\nStory date: ${snapshot.anchor}\n\n${brief.answer}`], { type: "text/plain" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "alex-morgan-demo-visit-brief.txt"; a.click(); URL.revokeObjectURL(url);
  }
  const visible = snapshot.records.filter(r => (!filter || r.sourceId === filter) && `${r.title} ${r.detail ?? ""} ${r.resourceType}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  return <section className="demo-workspace" aria-label="Guided patient demonstration">
    <div className="demo-topline"><span className="demo-pill">Presenter mode · fictional patient</span><span>Story date {date(snapshot.anchor)}</span><button className="demo-text-button" disabled={busy} onClick={() => void runAction("reset")}>Reset demo ↺</button></div>
    <header className="demo-heading"><div><p className="demo-eyebrow">WILD HEARTS / THE GUIDED STORY</p><h1>A complicated history.<br /><em>A clearer way forward.</em></h1><p>Follow Alex from scattered records to a more useful conversation with their care team.</p></div><div className="demo-patient"><div className="demo-avatar">AM</div><div><strong>{DEMO_NAME}</strong><span>34 · GI symptoms & allergy evaluation</span><small>Invented patient · 9 months of history</small></div></div></header>
    <nav className="demo-chapters" aria-label="Demo chapters">{chapters.map((item, index) => <button key={item.title} aria-current={chapter === index ? "step" : undefined} onClick={() => navigate(index)}><span>{visited.includes(index) && index !== chapter ? "✓" : String(index + 1).padStart(2, "0")}</span>{item.title}</button>)}</nav>
    <div className="demo-panel-heading"><div><p className="demo-eyebrow">CHAPTER {String(chapter + 1).padStart(2, "0")} / {chapters.length}</p><h2>{current.label}</h2></div><span className="demo-muted">{snapshot.records.length} stored records · {activeSources.length} clinics</span></div>
    {notice && <p className="demo-notice" role="status">{notice}</p>}{error && <p className="demo-error" role="alert">{error}</p>}

    {chapter === 0 && <>
      <div className="demo-grid demo-overview"><article className="demo-card demo-story"><span className="demo-pill">The starting point</span><h3>“I keep telling the same story.<br />I still don’t see the whole picture.”</h3><p>Alex has trouble swallowing, post-meal bloating, fatigue and occasional flushing. Three clinics hold different parts of the history. A new outside PDF has not yet joined the chart.</p><div className="demo-tags"><span>Biopsy-confirmed EoE</span><span>Persistent GI symptoms</span><span>MCAS unconfirmed</span></div><button className="btn" onClick={() => navigate(1)}>Bring the records together →</button></article>
      <aside className="demo-card"><p className="demo-eyebrow">WHAT ALEX WANTS TO KNOW</p><h3>What changed?<br />What’s still open?<br />What comes next?</h3><ul className="demo-clean-list"><li><b>Established</b><span>Eosinophilic esophagitis documented by GI.</span></li><li><b>Improving</b><span>Swallowing and follow-up biopsy findings.</span></li><li><b>Unresolved</b><span>Bloating, fatigue and intermittent flushing.</span></li></ul></aside></div>
      <div className="demo-stats"><article><span>Biopsy peak</span><strong>42 <i>→</i> 8</strong><small>eosinophils/hpf · improved, not “cured”</small></article><article><span>Weight trajectory</span><strong>68.5 <i>→</i> 66.4</strong><small>kg · recovered from a low of 65.8</small></article><article><span>Next conversation</span><strong>GI <i>in</i> 7 days</strong><small>{date(demoDay(snapshot.anchor, 7))} · fictional appointment</small></article></div>
    </>}

    {chapter === 1 && <>
      <div className="demo-source-grid">{activeSources.map(source => <article className="demo-card" key={source.id}><span className="demo-sync-dot">● Sample import complete</span><h3>{DEMO_SOURCES.find(s => s.key === source.key)?.name}</h3><p>{DEMO_SOURCES.find(s => s.key === source.key)?.clinician}</p><strong>{source.count} records</strong><small>Fixture replay · no live health-system connection</small></article>)}</div>
      <div className="demo-toolbar"><button className="btn" disabled={busy} onClick={() => void runAction("sync")}>{busy ? "Importing sample…" : "Replay sample sync"}</button><Link href="/app?view=records">Open the main record timeline ↗</Link><label>Clinic<select value={filter} onChange={e => setFilter(e.target.value)}><option value="">All clinics</option>{snapshot.sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>Search records<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Try biopsy, fatigue, ferritin…" /></label></div>
      <div className="demo-record-list">{visible.map(record => <button key={record.id} onClick={() => openEvidence(record.fhirId)}><span className="demo-record-date">{record.date ? date(record.date) : "Undated"}</span><span><strong>{record.title}</strong><small>{snapshot.sources.find(s => s.id === record.sourceId)?.name}</small></span><span className="demo-pill">{record.resourceType}</span><span aria-hidden="true">↗</span></button>)}{!visible.length && <p>No sample records match. Try another clinic or search.</p>}</div>
    </>}

    {chapter === 2 && <div className="demo-ask-grid"><aside className="demo-prompt-menu"><p className="demo-eyebrow">SIX WAYS TO MAKE THE CHART USEFUL</p>{DEMO_PROMPTS.map(item => <button key={item.id} aria-pressed={prompt?.id === item.id} disabled={item.id === "document" && !imported} onClick={() => { setPrompt(item); setEvidence(null); }}><strong>{item.title}</strong><span>{item.prompt}</span>{item.id === "document" && !imported && <small>Available after the PDF chapter</small>}</button>)}</aside><article className="demo-card demo-answer">{prompt ? <><p className="demo-question">{prompt.prompt}</p><div className="demo-answer-label"><span className="demo-avatar demo-avatar-small">h</span><strong>Holo</strong><span className="demo-pill">Prepared example</span></div><details className="demo-tool-replay"><summary>Walkthrough steps · scripted</summary><ol>{prompt.tools.map(tool => <li key={tool}>{tool}</li>)}</ol><p>These describe the example workflow. No model or tools run when selecting this prepared answer.</p></details>{prompt.answer.split("\n\n").map((text, i) => <p className="demo-answer-paragraph" key={i}>{text}</p>)}<div className="demo-citations"><strong>Underlying records</strong>{prompt.recordIds.map((id, i) => <button key={id} onClick={() => openEvidence(id)}>{i + 1}. {snapshot.records.find(r => r.fhirId === id)?.title ?? id}</button>)}</div>{"researchIds" in prompt && <div className="demo-citations"><strong>Research background</strong>{DEMO_RESEARCH.filter(r => (prompt.researchIds as readonly string[]).includes(r.id)).map(r => <a key={r.id} href={r.url} target="_blank" rel="noreferrer">{r.publisher}: {r.title} ↗</a>)}</div>}<div className="demo-toolbar"><Link className="btn" href={`/app/chat?prompt=${encodeURIComponent(prompt.prompt)}`}>Try this in live chat ↗</Link><button className="demo-text-button" onClick={downloadBrief}>Download visit brief</button></div><p className="demo-fineprint">Live chat uses the actual agent and stored demo records; its response and availability may vary. The prepared answer is an authored demonstration, not a generated clinical assessment.</p></> : <div className="demo-answer-empty"><span className="demo-avatar">h</span><h3>The chart has details.<br />Holo helps find the story.</h3><p>Choose a question to see a prepared, source-linked example. Then try it with the live agent.</p></div>}</article></div>}

    {chapter === 3 && <>
      <div className="demo-grid"><article className="demo-card"><span className="demo-pill">Sample PDF → prepared extraction → FHIR</span><h3>A report from outside the portals.</h3><p>Bring a fictional nutrition report into the story. The prepared mapping preserves the original finding and its page reference.</p><div className="demo-upload-zone"><span className="demo-file-symbol" aria-hidden="true">▤</span><strong>alex-morgan-demo-report.pdf</strong><span>One page · synthetic iron & nutrition review</span><div className="demo-toolbar"><a href="/api/demo/sample.pdf" download>Download sample PDF ↓</a><button className="btn" disabled={busy} onClick={() => fileInput.current?.click()}>Upload sample PDF</button></div><input ref={fileInput} hidden type="file" accept="application/pdf,.pdf" onChange={e => void choosePdf(e)} /><button className="demo-text-button" disabled={busy} onClick={() => void loadSample()}>Or load the provided sample in one click</button></div><p className="demo-fineprint">This guided path accepts only the provided PDF and replays its authored extraction. For actual OCR and other files, use <Link href="/app/wildcards">Documents</Link>.</p></article>
      <article className="demo-card"><p className="demo-eyebrow">PROVENANCE, NOT JUST A NUMBER</p><ol className="demo-pipeline"><li data-done={documentStage !== "idle"}><b>1</b><div><strong>Choose the source PDF</strong><span>Keep the original available for comparison.</span></div></li><li data-done={documentStage !== "idle"}><b>2</b><div><strong>Review the prepared extraction</strong><span>Ferritin 14 ng/mL · range 15–150 · page 1.</span></div></li><li data-done={imported}><b>3</b><div><strong>Save two FHIR resources</strong><span>Observation + DocumentReference in the encrypted store.</span></div></li><li data-done={imported}><b>4</b><div><strong>Search and ask about the finding</strong><span>Inspect the source or use the main chat tools.</span></div></li></ol></article></div>
      {documentStage !== "idle" && <article className="demo-card demo-extraction"><div><p className="demo-eyebrow">PREPARED EXTRACTION · PAGE 1</p><h3>Ferritin <em>14 ng/mL</em></h3><p>Printed reference: 15–150 ng/mL. Weight: 66.4 kg. The sample asks PCP to review fatigue and nutrition; it does not prescribe a treatment.</p><button className="btn" disabled={busy || imported} onClick={() => void mapDocument()}>{imported ? "✓ Saved to the demo chart" : busy ? "Saving…" : "Review complete · save mapped records"}</button></div><div><p className="demo-eyebrow">FHIR HANDOFF PREVIEW</p><pre>{JSON.stringify({ resourceType: "Observation", id: "outside-ferritin", code: { text: "Ferritin" }, valueQuantity: { value: 14, unit: "ng/mL" }, derivedFrom: [{ reference: "DocumentReference/outside-report" }] }, null, 2)}</pre><small>Compatible resource shape for a future Medplum integration. This demo writes to Wild Hearts, not Medplum.</small></div></article>}
      {imported && <div className="demo-toolbar"><button className="btn" onClick={() => { navigate(2); setPrompt(DEMO_PROMPTS.find(p => p.id === "document")!); }}>Ask what this PDF adds →</button><a href="/api/demo/fhir?type=Observation&q=ferritin" target="_blank" rel="noreferrer">Query stored ferritin resources ↗</a><button className="demo-text-button" onClick={() => openEvidence("outside-report")}>Open the mapped source</button></div>}
    </>}

    {chapter === 4 && <>
      <div className="demo-grid"><article className="demo-card"><p className="demo-eyebrow">UP NEXT IN ALEX’S STORY</p><h3>Three conversations.<br />One shared history.</h3><div className="demo-appointments">{appointments.map(item => <div key={item.id}><span>{item.date ? date(item.date) : "Date pending"}</span><strong>{item.title}</strong><button className="demo-text-button" onClick={() => openEvidence(item.fhirId)}>View appointment record ↗</button></div>)}</div><div className="demo-toolbar"><button className="btn" onClick={downloadBrief}>Download GI visit brief ↓</button><button className="demo-text-button" onClick={() => { navigate(2); setPrompt(DEMO_PROMPTS.find(p => p.id === "visit")!); }}>Build a visit brief</button></div><p className="demo-fineprint">Fictional bookings relative to the story date. No real appointment is made.</p></article>
      <article className="demo-card demo-messages"><span className="demo-pill">Messaging & email · simulated</span><h3>Keep the conversation moving.</h3><div className="demo-message-switch"><button aria-pressed={messageMode === "portal"} onClick={() => setMessageMode("portal")}>Provider message</button><button aria-pressed={messageMode === "email"} onClick={() => setMessageMode("email")}>Email</button></div><div className="demo-inbox"><small>{messageMode === "portal" ? "Cedar Digestive Health · care team" : "appointments@cedar.example · fictional inbox"}</small><p>{messageMode === "portal" ? "We have your follow-up on the calendar. Please bring your symptom diary and any outside reports so we can review them together." : "Your GI follow-up reminder: bring your current medicine list, pathology reports and the outside nutrition report. This is a sample email."}</p></div><label htmlFor="demo-message">Draft for Dr. Park</label><textarea id="demo-message" rows={5} maxLength={2000} value={draft} onChange={e => setDraft(e.target.value)} /><button className="btn" disabled={!draft.trim()} onClick={() => setNotice(`Simulated ${messageMode === "portal" ? "provider message" : "email"} added to this presentation. Nothing was sent to a provider or email address.`)}>Simulate {messageMode === "portal" ? "sending a message" : "sending an email"} →</button><p className="demo-fineprint">This is a UI demonstration. No provider portal or email service is connected; draft text stays in this page.</p></article></div>
    </>}

    {chapter === 5 && <><p className="demo-lede">Chart evidence tells us what happened to Alex. Research helps explain the background—and what the records cannot prove.</p><div className="demo-grid">{DEMO_RESEARCH.map(source => <article className="demo-card demo-research" key={source.id}><span className="demo-pill">{source.publisher} · {source.published}</span><h3>{source.title}</h3><p>{source.text}</p><p className="demo-wiki-path">{source.path}</p><a href={source.url} target="_blank" rel="noreferrer">Read the original source ↗</a><small>Authored summary · reviewed for this demo · not a live search of the production research wiki</small></article>)}</div><article className="demo-card demo-research-note"><strong>The distinction worth showing</strong><p>The chart supports EoE and documents an unresolved flushing evaluation. A general article must never turn “possible MCAS” into Alex’s diagnosis. The diary shows an association; it does not establish a trigger.</p><button className="btn" onClick={() => { navigate(2); setPrompt(DEMO_PROMPTS.find(p => p.id === "research")!); }}>See the source-linked example →</button></article></>}

    {evidence && <article className="demo-card demo-evidence" id="demo-evidence" tabIndex={-1}><div className="demo-evidence-heading"><div><p className="demo-eyebrow">UNDERLYING FHIR RECORD · FICTIONAL DATA</p><h3>{evidence.title}</h3></div><button className="demo-text-button" onClick={() => setEvidence(null)}>Close record ×</button></div><p>{evidence.detail}</p><dl><div><dt>Reference</dt><dd>{evidence.resourceType}/{evidence.fhirId}</dd></div><div><dt>Organization</dt><dd>{snapshot.sources.find(s => s.id === evidence.sourceId)?.name}</dd></div><div><dt>Date</dt><dd>{evidence.date ? date(evidence.date) : "Not recorded"}</dd></div>{evidence.sections.map((section, i) => <div key={i}><dt>{section.label}</dt><dd>{section.values.join(" · ")}</dd></div>)}</dl><details><summary>Inspect the synthetic FHIR resource</summary><pre>{JSON.stringify(evidence.resource, null, 2)}</pre></details></article>}
    <footer className="demo-tour-footer"><div><span className="demo-eyebrow">PRESENTER CUE</span><p>{current.cue}</p></div><div className="demo-tour-controls"><button className="demo-text-button" disabled={chapter === 0} onClick={() => navigate(chapter - 1)}>← Back</button><button className="btn" onClick={() => navigate(chapter === chapters.length - 1 ? 0 : chapter + 1)}>{chapter === chapters.length - 1 ? "Back to the story" : "Next chapter →"}</button></div></footer>
  </section>;
}
