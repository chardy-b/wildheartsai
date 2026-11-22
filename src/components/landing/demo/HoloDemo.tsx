"use client";

import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { HEART_PATH } from "../marks";
import {
  A1C_SAMPLES, AUDIOLOGY_TEXT, DATELINE, DOC, FOLLOW_UP, IMPORTED_RECORDS, IMPORT_STAGES, MEDS, MRI_TEXT, NEXT_VISIT, OUTSIDE_RESULT, RECONNECT, RESULTS, SRC, SUMMARY, VISITS,
  briefFor, briefText, fmt, refillText, visitOf, type Src, type VisitId,
} from "./demo-data";
import { choicesFor, hasTurn, initialState, keyOf, labelOf, nextPrep, pendingTurn, reducer, type Choice, type DemoState, type Kind, type Turn } from "./demo-state";
import { A1cVisual, AllergyVisual, AudiogramVisual, FerritinVisual, MriVisual, PathologyVisual } from "./result-visuals";
import "./holo-demo.css";

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const BEAT_MS = 380;
const IMPORT_MS = 1300;

type Go = (c: Choice) => void;
type HRef = (key: string) => (el: HTMLHeadingElement | null) => void;
type WidgetProps = { state: DemoState; go: Go; hRef: HRef };

const stagger = (i: number) => ({ "--i": i }) as CSSProperties;

function HoloLine({ avatarSrc, children, typing = false }: { avatarSrc: string; children?: ReactNode; typing?: boolean }) {
  return (
    <div className="hd-row">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="hd-avatar" src={avatarSrc} alt="" width={40} height={40} decoding="async" />
      {typing ? (
        <div className="hd-bubble hd-dots" aria-hidden="true"><i /><i /><i /></div>
      ) : (
        <div className="hd-bubble">{children}</div>
      )}
    </div>
  );
}

function Widget({ id, kicker, title, badge, children, hRef }: { id: string; kicker?: string; title: string; badge?: string; children: ReactNode; hRef: (el: HTMLHeadingElement | null) => void }) {
  return (
    <section className="hd-widget" aria-labelledby={`hd-h-${id}`}>
      <header className="hd-widget-head">
        <div>
          {kicker && <p className="hd-kicker">{kicker}</p>}
          <h2 id={`hd-h-${id}`} tabIndex={-1} ref={hRef}>{title}</h2>
        </div>
        {badge && <span className="hd-badge">{badge}</span>}
      </header>
      <div className="hd-widget-body">{children}</div>
    </section>
  );
}

function Sources({ items, label = "Sources" }: { items: Src[]; label?: string }) {
  return (
    <details className="hd-details">
      <summary>{label}</summary>
      <ul>
        {items.map((s) => (
          <li key={fmt(s)}>
            <strong>{fmt(s)}</strong>
            {s.what && <> — {s.what}</>}
          </li>
        ))}
      </ul>
    </details>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function AppointmentsCard({ state, go }: Pick<WidgetProps, "state" | "go">) {
  return (
    <section className="hd-card hd-appts" aria-labelledby="hd-appts-title">
      <header className="hd-card-head">
        <h2 id="hd-appts-title">Upcoming appointments</h2>
        {state.importStage === "imported" && <span className="hd-badge" data-tone="soft">Sample import added</span>}
      </header>
      <ul>
        {VISITS.map((v, i) => {
          const opened = hasTurn(state, { kind: "prep", arg: v.id });
          return (
            <li key={v.id} className="hd-visit" data-next={i === 0} style={stagger(i)}>
              <span className="hd-date" aria-hidden="true">{v.month}<strong>{v.day}</strong></span>
              <span className="hd-visit-text">
                <strong>{v.name}</strong>
                <span>{v.person} · {v.about}</span>
                <span className="hd-muted">{v.clinic} · {v.date}</span>
              </span>
              <button type="button" className="hd-btn" data-variant={i === 0 ? "solid" : undefined} data-visit={v.id} aria-label={`${opened ? "Open brief for" : "Prepare for"} ${v.name}, ${v.date}`} onClick={() => go({ kind: "prep", arg: v.id })}>
                {opened ? "Brief" : "Prep"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FollowUpCard({ state, go, dispatch }: Pick<WidgetProps, "state" | "go"> & { dispatch: (a: { type: "markRead" }) => void }) {
  return (
    <details className="hd-card hd-followup" data-read={state.followUpRead} onToggle={(e) => { if (e.currentTarget.open) dispatch({ type: "markRead" }); }}>
      <summary aria-label={`Message from the care team: ${FOLLOW_UP.subject}. ${state.followUpRead ? "Read" : "Unread"}`}>
        <span className="hd-dot" aria-hidden="true" />
        <span className="hd-sum-text">
          <strong>{FOLLOW_UP.subject}</strong>
          <span className="hd-muted">{FOLLOW_UP.from} · {FOLLOW_UP.received}</span>
        </span>
        <span className="hd-badge" data-tone={state.followUpRead ? undefined : "new"}>{state.followUpRead ? "Read" : "New"}</span>
      </summary>
      <div className="hd-followup-body">
        <p>{FOLLOW_UP.body}</p>
        <div className="hd-actions">
          <button type="button" className="hd-btn" data-variant="solid" onClick={() => go({ kind: "prep", arg: "dietitian" })}>Prepare for dietitian visit</button>
          <button type="button" className="hd-btn" onClick={() => go({ kind: "doc" })}>Review outside report</button>
        </div>
      </div>
    </details>
  );
}

function ConnectStrip({ state, go }: Pick<WidgetProps, "state" | "go">) {
  const opened = hasTurn(state, { kind: "connect" });
  const imported = state.importStage === "imported";
  return (
    <section className="hd-card hd-strip" aria-label={RECONNECT.name}>
      <span className="hd-strip-text">
        <strong>{RECONNECT.name}</strong>
        <span className="hd-muted">{imported ? `${IMPORTED_RECORDS.length} sample records brought in` : RECONNECT.text}</span>
      </span>
      <button type="button" className="hd-btn" data-flow="connect" onClick={() => go({ kind: "connect" })}>{opened ? "View" : "Connect"}</button>
    </section>
  );
}

export function BriefWidget({ id, state, go, hRef }: WidgetProps & { id: VisitId }) {
  const [status, setStatus] = useState("");
  const brief = briefFor(id, { added: state.docAdded, imported: state.importStage === "imported", a1cQuestionAdded: state.a1cQuestionAdded });
  const text = briefText(brief);
  const groups: [string, typeof brief.say][] = [["What to say", brief.say], ["What to ask", brief.ask], ["What to bring", brief.bring]];
  const isNew = (source: string) => source.startsWith("Outside") || source.startsWith("Sample import");
  return (
    <Widget id={`prep-${id}`} kicker={`${brief.when} · ${brief.sub}`} title={`Your ${brief.title}`} badge="Visit brief" hRef={hRef(`prep:${id}`)}>
      <div className="hd-brief">
        {groups.map(([label, lines], g) => (
          <section key={label} className="hd-group" style={stagger(g)}>
            <h3>{label}</h3>
            <ul>
              {lines.map((l) => (
                <li key={l.text} data-new={isNew(l.source)}>
                  {l.text}
                  <span className="hd-src">{l.source}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <Sources items={brief.sources} label="Source receipt" />
      <div className="hd-actions">
        <button type="button" className="hd-btn" data-variant="solid" onClick={async () => setStatus((await copy(text)) ? "Brief copied." : "Copy isn’t available here. Try Download.")}>Copy brief</button>
        <button type="button" className="hd-btn" onClick={() => { download(`alex-${id}-visit-brief.txt`, text); setStatus("Download started."); }}>Download .txt</button>
        {!state.docAdded && <button type="button" className="hd-btn" data-flow="doc" onClick={() => go({ kind: "doc" })}>Review outside report</button>}
      </div>
      <p className="hd-status" role="status">{status}</p>
    </Widget>
  );
}

function ConnectWidget({ state, onImport, hRef }: { state: DemoState; onImport: () => void; hRef: HRef }) {
  const stage = state.importStage === "ready" ? 0 : state.importStage === "importing" ? 1 : 2;
  return (
    <Widget id="connect" kicker="Patient portal" title={RECONNECT.name} badge="Sample import" hRef={hRef("connect")}>
      <ol className="hd-stages" aria-label="Import progress">
        {IMPORT_STAGES.map((label, i) => (
          <li key={label} data-state={i < stage || stage === 2 ? "done" : i === stage ? "current" : "todo"} aria-current={i === stage ? "step" : undefined}>
            <span aria-hidden="true">{i < stage || stage === 2 ? "✓" : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {stage === 1 && <div className="hd-bar-track" aria-hidden="true"><i /></div>}
      {stage === 0 && (
        <div className="hd-actions">
          <button type="button" className="hd-btn" data-variant="solid" data-flow="import" onClick={onImport}>Preview sample import</button>
        </div>
      )}
      {stage === 2 && (
        <ul className="hd-imported" aria-label="Records brought in">
          {IMPORTED_RECORDS.map((r, i) => (
            <li key={r.name} style={stagger(i)}>
              <strong>{r.name}</strong>
              <span className="hd-muted">{r.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

function MedsWidget({ state, dispatch, hRef }: { state: DemoState; dispatch: (a: { type: "draftRefill"; id: string | null }) => void; hRef: HRef }) {
  const [status, setStatus] = useState("");
  const picked = MEDS.find((m) => m.id === state.refill);
  return (
    <Widget id="meds" kicker="Charted medicines" title="Your medicine list" badge="From the chart" hRef={hRef("meds")}>
      <ul className="hd-meds">
        {MEDS.map((m, i) => (
          <li key={m.id} style={stagger(i)}>
            <div>
              <strong>{m.name}</strong> <span className="hd-dose">{m.dose}</span>
              <p>{m.note}</p>
              <span className="hd-src">{fmt(m.src)}</span>
            </div>
            <button type="button" className="hd-btn" aria-pressed={state.refill === m.id} data-refill={m.id} onClick={() => { setStatus(""); dispatch({ type: "draftRefill", id: state.refill === m.id ? null : m.id }); }}>
              {state.refill === m.id ? "Drafted" : "Draft refill"}
            </button>
          </li>
        ))}
      </ul>
      {picked && (
        <div className="hd-paper" aria-live="polite">
          <p className="hd-kicker">Refill draft · {picked.name}</p>
          <p>{refillText(picked)}</p>
          <div className="hd-actions">
            <button type="button" className="hd-btn" onClick={async () => setStatus((await copy(refillText(picked))) ? "Draft copied." : "Copy isn’t available here.")}>Copy draft</button>
          </div>
        </div>
      )}
      <p className="hd-status" role="status">{status}</p>
      <Sources items={[SRC.gi, SRC.allergy]} />
    </Widget>
  );
}

function FinderWidget({ state, go, hRef }: WidgetProps) {
  const items = [...RESULTS, ...(state.docAdded ? [OUTSIDE_RESULT] : [])];
  return (
    <Widget id="finder" kicker="Alex’s results" title="Find a result" badge="Chart" hRef={hRef("finder")}>
      <ul className="hd-finder">
        {items.map((r, i) => (
          <li key={r.id} style={stagger(i)}>
            <button type="button" className="hd-pick" data-result={r.id} onClick={() => go({ kind: "result", arg: r.id })}>
              <span>
                <span className="hd-result-type">{r.modality}</span>
                <strong>{r.title}</strong>
                <small>{r.sub}</small>
              </span>
              {r.id === "outside" ? <span className="hd-badge" data-tone="new">New</span> : <span aria-hidden="true" className="hd-chev">›</span>}
            </button>
          </li>
        ))}
      </ul>
    </Widget>
  );
}

export function ResultWidget({ id, state, go, hRef, mriImageSrc, onAddA1cQuestion }: WidgetProps & { id: string; mriImageSrc: string; onAddA1cQuestion: () => void }) {
  const h = hRef(`result:${id}`);
  if (id === "a1c") return (
    <Widget id="r-a1c" kicker="Two clinics · Mar 2024–Jun 2025" title="A1C trend" badge="Synthetic" hRef={h}>
      <p>It’s gone up a little at each check, across two clinics: 5.9%, 6.0%, 6.1%.</p>
      <A1cVisual />
      <p>Want to raise this at your next visit, on {NEXT_VISIT.date}? I can add it to your questions.</p>
      <p className="hd-visual-note">Fictional sample results, not a diagnosis. These checks do not show a current A1C.</p>
      <div className="hd-actions">
        <button type="button" className="hd-btn" data-variant="solid" data-flow="add-a1c-question" aria-pressed={state.a1cQuestionAdded} onClick={onAddA1cQuestion}>{state.a1cQuestionAdded ? "Added to questions" : "Add to questions"}</button>
        {state.a1cQuestionAdded && <button type="button" className="hd-btn" data-flow="a1c-brief" onClick={() => go({ kind: "prep", arg: NEXT_VISIT.id })}>Open {NEXT_VISIT.short} brief · {NEXT_VISIT.date}</button>}
      </div>
      <p className="hd-status" role="status">{state.a1cQuestionAdded ? `Added to your ${NEXT_VISIT.date} ${NEXT_VISIT.short} visit questions.` : ""}</p>
      <Sources items={A1C_SAMPLES.map((s) => s.source)} label="Open sources" />
    </Widget>
  );
  if (id === "biopsy")
    return (
      <Widget id="r-biopsy" kicker="Pathology · Cedar Digestive Health" title="Biopsy trend" badge="Chart" hRef={h}>
        <PathologyVisual />
        <p>The peak count was lower at the repeat biopsy, and the GI note describes improved swallowing. This is not a claim of cure.</p>
        <Sources items={[SRC.path, SRC.gi]} label="Dated sources" />
      </Widget>
    );
  if (id === "ferritin")
    return (
      <Widget id="r-ferritin" kicker="Juniper Primary Care · 25 May 2026" title={state.docAdded ? "Ferritin comparison" : "Ferritin, earlier result"} badge="Chart" hRef={h}>
        <FerritinVisual confirmed={state.docAdded} />
        <p>Primary care later requested a repeat CBC and ferritin because fatigue persisted.</p>
        <div className="hd-actions">
          {state.docAdded ? (
            <button type="button" className="hd-btn" data-variant="solid" onClick={() => go({ kind: "result", arg: "outside" })}>See the more recent result</button>
          ) : (
            <button type="button" className="hd-btn" data-flow="doc" onClick={() => go({ kind: "doc" })}>Review outside report</button>
          )}
        </div>
        <Sources items={[SRC.ferritinOld, SRC.pcp, ...(state.docAdded ? [SRC.outside] : [])]} label="Dated sources" />
      </Widget>
    );
  if (id === "outside")
    return (
      <Widget id="r-outside" kicker="Outside report · 18 Nov 2026 · page 1" title="Ferritin, outside report" badge="Added" hRef={h}>
        <FerritinVisual confirmed={state.docAdded} />
        <p>Compared with 22 ng/mL on 25 May 2026. It is now listed in this brief for your visits, for the care team to review with the fatigue follow-up.</p>
        <Sources items={[SRC.outside, SRC.ferritinOld]} label="Dated sources" />
      </Widget>
    );
  if (id === "allergy") return (
    <Widget id="r-allergy" kicker="Environmental allergens · 26 Aug 2026" title="Skin-prick panel" badge="Synthetic" hRef={h}>
      <AllergyVisual />
      <Sources items={[{ who: "Synthetic environmental allergy panel", when: "26 Aug 2026", what: "Invented wheal measurements at 15 minutes, including histamine and saline controls. Separate from the 23 Aug flushing note; not event-timed mediator testing." }]} label="Source" />
    </Widget>
  );
  const mri = id === "mri";
  return (
    <Widget id={`r-${id}`} kicker={mri ? "Imaging · 10 Nov 2026" : "Audiology · 12 Nov 2026"} title={mri ? "Brain MRI" : "Audiology"} badge="Sample report" hRef={h}>
      {mri ? <MriVisual src={mriImageSrc} /> : <AudiogramVisual />}
      <p className="hd-kicker">Alex’s sample report · excerpt</p>
      <blockquote className="hd-quote">“{mri ? MRI_TEXT : AUDIOLOGY_TEXT}”</blockquote>
      <Sources items={[{ who: mri ? "Imaging report" : "Audiology report", when: mri ? "10 Nov 2026" : "12 Nov 2026", what: "Sample report text." }]} label="Source" />
    </Widget>
  );
}

function DocWidget({ state, go, dispatch, hRef }: WidgetProps & { dispatch: (a: { type: "confirmDoc" }) => void }) {
  const f = DOC.finding;
  return (
    <Widget id="doc" kicker={DOC.file} title="Review outside report" badge="Sample document" hRef={hRef("doc")}>
      <div className="hd-doc">
        <div className="hd-page" role="img" aria-label={`Page 1 of the report: ${DOC.title}. Ferritin 14 ng/mL, printed range 15–150 ng/mL.`}>
          <p className="hd-kicker">Page 1 of 1</p>
          <h3>{DOC.title}</h3>
          <p>{DOC.patient}</p>
          <dl>
            {DOC.rows.map(([k, v]) => (
              <div key={k} className={k === "Ferritin" ? "hd-hit" : undefined}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
          <p>{DOC.footer}</p>
        </div>
        <div className="hd-extract">
          <h3>Finding from page 1</h3>
          <table>
            <tbody>
              <tr><th scope="row">Test</th><td>{f.test}</td></tr>
              <tr><th scope="row">Value</th><td><strong>{f.value}</strong></td></tr>
              <tr><th scope="row">Printed range</th><td>{f.range}</td></tr>
              <tr><th scope="row">Date</th><td>{f.date}</td></tr>
              <tr><th scope="row">Source</th><td>{f.page}</td></tr>
            </tbody>
          </table>
          {state.docAdded ? (
            <>
              <p className="hd-done" role="status"><span aria-hidden="true">✓</span> Added to results and visit briefs</p>
              <div className="hd-actions">
                <button type="button" className="hd-btn" data-variant="solid" onClick={() => go({ kind: "result", arg: "outside" })}>Open result</button>
                <button type="button" className="hd-btn" onClick={() => go(nextPrep(state))}>Open brief</button>
              </div>
            </>
          ) : (
            <div className="hd-actions">
              <button type="button" className="hd-btn" data-variant="solid" data-flow="confirm" onClick={() => dispatch({ type: "confirmDoc" })}>Confirm &amp; add</button>
            </div>
          )}
        </div>
      </div>
    </Widget>
  );
}

function SummaryWidget({ go, hRef }: WidgetProps) {
  type Row = { text: string; go: { kind: string; arg: string; label: string } };
  const cols: [string, string, readonly Row[]][] = [
    ["Established", "established", SUMMARY.established],
    ["Improving", "improving", SUMMARY.improving],
    ["Uncertain", "uncertain", SUMMARY.uncertain],
  ];
  return (
    <Widget id="summary" kicker="From the notes" title="Chart summary" badge="Chart" hRef={hRef("summary")}>
      <div className="hd-summary">
        {cols.map(([label, tone, rows], i) => (
          <section key={label} data-tone={tone} style={stagger(i)}>
            <h3>{label}</h3>
            <ul>
              {rows.map((r) => (
                <li key={r.text}>
                  {r.text}
                  <button type="button" className="hd-link" onClick={() => go({ kind: r.go.kind as Kind, arg: r.go.arg })}>{r.go.label} ↗</button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <Sources items={[...SUMMARY.sources]} label="Source notes" />
    </Widget>
  );
}

const HOLO_LINE: Record<Kind, (t: Turn) => string> = {
  prep: (t) => `Here’s a short brief for ${visitOf(t.arg ?? "gi").person}. Each line shows where it came from.`,
  meds: () => "This is what the chart lists, not a check of what you take today.",
  connect: () => "Here’s how records would arrive in this chat.",
  finder: () => "Which result would you like to see?",
  result: (t) => (t.arg === "biopsy" ? "Both pathology results, side by side." : "Here’s the result and its source."),
  doc: () => "Here’s the page next to what I found on it. Confirm it to add it.",
  summary: () => "Here’s where the chart stands.",
};

const READY: Record<Kind, string> = { prep: "Visit brief", meds: "Medicine list", connect: "Connect MyChart UCSF", finder: "Find a result", result: "Result", doc: "Outside report", summary: "Chart summary" };

function DemoRun({ avatarSrc, mriImageSrc, focusStart }: { avatarSrc: string; mriImageSrc: string; focusStart: boolean }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [live, setLive] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const heads = useRef<Record<string, HTMLHeadingElement | null>>({});
  const shown = useRef<string | null>(null);

  const pending = pendingTurn(state);
  const choices = choicesFor(state);

  useEffect(() => {
    if (!focusStart) return;
    window.scrollTo({ top: 0, behavior: "auto" });
    root.current?.querySelector<HTMLElement>(".hd-bar button")?.focus({ preventScroll: true });
  }, [focusStart]);

  // The beat: after a choice, Holo pauses briefly, then the widget arrives.
  const pendingKey = pending?.key;
  const pendingKind = pending?.kind;
  useEffect(() => {
    if (!pendingKey || !pendingKind) return;
    const t = window.setTimeout(() => {
      dispatch({ type: "reveal", key: pendingKey });
      setLive(`${READY[pendingKind]} is ready.`);
    }, reduced() ? 0 : BEAT_MS);
    return () => window.clearTimeout(t);
  }, [pendingKey, pendingKind]);

  const importing = state.importStage === "importing";
  useEffect(() => {
    if (!importing) return;
    const t = window.setTimeout(() => {
      dispatch({ type: "finishImport" });
      setLive("Sample records imported.");
    }, reduced() ? 0 : IMPORT_MS);
    return () => window.clearTimeout(t);
  }, [importing]);

  const show = useCallback((key: string) => {
    const turn = root.current?.querySelector<HTMLElement>(`[data-turn="${key}"]`);
    turn?.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" });
    heads.current[key]?.focus({ preventScroll: true });
  }, []);

  // Bring each newly revealed widget into view and move focus to its heading.
  const lastRevealed = [...state.turns].reverse().find((t) => t.revealed)?.key;
  useEffect(() => {
    if (!lastRevealed || shown.current === lastRevealed) return;
    shown.current = lastRevealed;
    show(lastRevealed);
  }, [lastRevealed, show]);

  const go: Go = (c) => {
    if (c.kind === "browse") {
      dispatch({ type: "browse" });
      setLive("Showing all options.");
      return;
    }
    const key = keyOf(c);
    if (state.turns.some((t) => t.key === key)) {
      if (state.turns.find((t) => t.key === key)?.revealed) show(key);
      return;
    }
    if (pending) return;
    dispatch({ type: "choose", kind: c.kind, arg: c.arg });
    setLive(`${labelOf(c)}.`);
  };

  const hRef: HRef = (key) => (el) => {
    heads.current[key] = el;
  };
  const props: WidgetProps = { state, go, hRef };

  const body = (t: Turn) => {
    switch (t.kind) {
      case "prep": return <BriefWidget {...props} id={(t.arg as VisitId) ?? "gi"} />;
      case "meds": return <MedsWidget state={state} dispatch={dispatch} hRef={hRef} />;
      case "connect": return <ConnectWidget state={state} hRef={hRef} onImport={() => { heads.current.connect?.focus({ preventScroll: true }); dispatch({ type: "startImport" }); setLive("Importing sample records."); }} />;
      case "finder": return <FinderWidget {...props} />;
      case "result": return <ResultWidget {...props} id={t.arg ?? "biopsy"} mriImageSrc={mriImageSrc} onAddA1cQuestion={() => dispatch({ type: "addA1cQuestion" })} />;
      case "doc": return <DocWidget {...props} dispatch={(a) => { heads.current.doc?.focus({ preventScroll: true }); dispatch(a); setLive("Added to results and visit briefs."); }} />;
      case "summary": return <SummaryWidget {...props} />;
    }
  };

  return (
    <div className="hd-run" ref={root}>
      <main className="hd-main" id="hd-conversation">
        <h1 className="hd-sr">Conversation with Holo</h1>
        <div className="hd-thread">
          <p className="hd-dateline">{DATELINE}</p>
          <div className="hd-turn hd-turn-first">
            <HoloLine avatarSrc={avatarSrc}>Hi Alex, I’m Holo. Three visits are coming up, and there’s a new follow-up from your care team.</HoloLine>
            <AppointmentsCard state={state} go={go} />
            <FollowUpCard state={state} go={go} dispatch={dispatch} />
            <ConnectStrip state={state} go={go} />
          </div>

          {state.turns.map((t) => (
            <div key={t.key} className="hd-turn" data-turn={t.key}>
              <div className="hd-you"><p>{labelOf({ kind: t.kind, arg: t.arg })}</p></div>
              {t.revealed ? (
                <>
                  <HoloLine avatarSrc={avatarSrc}>{HOLO_LINE[t.kind](t)}</HoloLine>
                  {body(t)}
                </>
              ) : (
                <HoloLine avatarSrc={avatarSrc} typing />
              )}
            </div>
          ))}
        </div>
      </main>

      <nav className="hd-bar" aria-label="What next">
        <div className="hd-bar-inner">
          {choices.map((c) => (
            <button key={keyOf(c) + (c.arg ?? "")} type="button" className="hd-choice" data-choice={c.kind} data-arg={c.arg} data-variant={c.kind === "browse" ? "back" : undefined} onClick={() => go(c)}>
              {c.kind === "browse" && <span aria-hidden="true">← </span>}
              {labelOf(c)}
            </button>
          ))}
        </div>
      </nav>

      <p className="hd-sr" role="status" aria-live="polite">{live}</p>
    </div>
  );
}

export function HoloDemo({ avatarSrc = "/holo-demo.webp", mriImageSrc = "/demo/mri-phantom.webp" }: { avatarSrc?: string; mriImageSrc?: string }) {
  const [run, setRun] = useState(0);
  return (
    <div className="hd">
      <header className="hd-top">
        {/* The same plain link also works in the offline review build, without a Next router or prefetch. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a className="hd-brand" href="/" aria-label="Wild Hearts Health home">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={HEART_PATH} /></svg>
          <span>Wild Hearts Health</span>
        </a>
        <span className="hd-pill">Demo</span>
        <span className="hd-spacer" />
        <button type="button" className="hd-top-btn" onClick={() => setRun((n) => n + 1)}>Restart</button>
        <a className="hd-top-link" href="/sign-up">Sign up</a>
      </header>
      <DemoRun key={run} avatarSrc={avatarSrc} mriImageSrc={mriImageSrc} focusStart={run > 0} />
    </div>
  );
}
