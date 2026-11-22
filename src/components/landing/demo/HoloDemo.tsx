"use client";

import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { HEART_PATH } from "../marks";
import { BRIEF, COMPARE_ROWS, FOLLOW_UP, IMPORTED_SAMPLE, IMPORT_STAGES, LAB_SAMPLE, MEDS, NEXT_VISIT, SOURCES } from "./demo-data";
import { FLOW_LABEL, choicesFor, initialState, pendingEntry, progressFor, reducer, type DemoState, type Flow } from "./demo-state";
import "./holo-demo.css";

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const BEAT_MS = 520;
const IMPORT_MS = 1100;

const HOLO_LINE: Record<Flow, string> = {
  prepare: "Here is a brief built from the follow-up and two clinic records. Every line shows where it came from.",
  connect: "You can preview how connecting a health system would look. This is a simulation with sample records.",
  meds: "These are the medications listed across both clinics. You can try drafting a refill note without sending it.",
  compare: "Here are the two clinic records side by side.",
  lab: "The outside lab report is already loaded as a sample. Check it and confirm it looks right.",
};

function HoloFace({ small = false }: { small?: boolean }) {
  return (
    <svg className={small ? "holo-face holo-face-sm" : "holo-face"} viewBox="0 0 48 40" aria-hidden="true">
      <ellipse cx="22" cy="22" rx="20" ry="16" className="holo-face-bg" />
      <g className="holo-eyes">
        <ellipse cx="14" cy="21" rx="3.3" ry="3.9" />
        <ellipse cx="30" cy="21" rx="3.3" ry="3.9" />
        <circle cx="15.1" cy="19.6" r="1.1" className="holo-glint" />
        <circle cx="31.1" cy="19.6" r="1.1" className="holo-glint" />
      </g>
      <path d="M17 28.5q5 3.2 10 0" className="holo-smile" />
      <g transform="translate(34 2) scale(0.55)">
        <path d={HEART_PATH} className="holo-heart" />
      </g>
    </svg>
  );
}

function Holo({ children }: { children: ReactNode }) {
  return (
    <div className="hd-row hd-row-holo">
      <HoloFace small />
      <div className="hd-bubble hd-bubble-holo">{children}</div>
    </div>
  );
}

function Widget({ flow, title, children, headingRef }: { flow: string; title: string; children: ReactNode; headingRef: (el: HTMLHeadingElement | null) => void }) {
  return (
    <section className="hd-widget" data-flow={flow} aria-labelledby={`hd-w-${flow}`}>
      <h4 id={`hd-w-${flow}`} tabIndex={-1} ref={headingRef}>{title}</h4>
      {children}
    </section>
  );
}

function Receipt({ children }: { children: ReactNode }) {
  return <span className="hd-receipt">{children}</span>;
}

function BriefWidget({ state, headingRef }: { state: DemoState; headingRef: (el: HTMLHeadingElement | null) => void }) {
  const imported = state.importStage === "imported";
  const groups: [string, typeof BRIEF.say][] = [["What to say", BRIEF.say], ["What to ask", BRIEF.ask], ["What to bring", BRIEF.bring]];
  return (
    <Widget flow="prepare" title={`Your visit brief · ${NEXT_VISIT.date}`} headingRef={headingRef}>
      <ul className="hd-sources" aria-label="Sources used">
        {SOURCES.map((s, i) => (
          <li key={s.id} style={{ "--i": i } as CSSProperties}>
            <span className="hd-src-dot" aria-hidden="true" />
            <strong>{s.name}</strong> · {s.from} · {s.date}
          </li>
        ))}
        {imported && (
          <li style={{ "--i": 3 } as CSSProperties}>
            <span className="hd-src-dot" aria-hidden="true" />
            <strong>Sample import</strong> · fictional records · not from UCSF
          </li>
        )}
      </ul>
      <div className="hd-brief">
        {groups.map(([label, items], g) => (
          <div key={label} className="hd-brief-group" style={{ "--g": g } as CSSProperties}>
            <h5>{label}</h5>
            <ul>
              {items.map((item) => (
                <li key={item.text}>
                  {item.text} <Receipt>{item.source}</Receipt>
                </li>
              ))}
              {label === "What to bring" && imported && (
                <li>
                  The sample after-visit summary shown above. <Receipt>Sample import · fictional</Receipt>
                </li>
              )}
            </ul>
          </div>
        ))}
      </div>
      <p className="hd-fine">Sample text for illustration. It is not medical advice and does not suggest changing any medicine.</p>
    </Widget>
  );
}

function ConnectWidget({ state, onImport, headingRef }: { state: DemoState; onImport: () => void; headingRef: (el: HTMLHeadingElement | null) => void }) {
  const stage = state.importStage === "ready" ? 0 : state.importStage === "importing" ? 1 : 2;
  return (
    <Widget flow="connect" title="Connect MyChart UCSF" headingRef={headingRef}>
      <p className="hd-note">Simulation only. No MyChart portal was opened and nothing was imported from UCSF. The records below are fictional.</p>
      <ol className="hd-stages" aria-label="Import progress">
        {IMPORT_STAGES.map((label, i) => (
          <li key={label} data-state={i < stage ? "done" : i === stage ? "current" : "todo"} aria-current={i === stage ? "step" : undefined}>
            <span aria-hidden="true">{i < stage || stage === 2 ? "✓" : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {stage === 0 && (
        <button type="button" className="hd-btn" onClick={onImport}>
          Preview sample import
        </button>
      )}
      {stage === 1 && <p className="hd-fine" aria-hidden="true">Importing sample records…</p>}
      {stage === 2 && (
        <div className="hd-imported">
          <h5>Example of what would appear</h5>
          <ul>
            {IMPORTED_SAMPLE.map((r, i) => (
              <li key={r.name} style={{ "--i": i } as CSSProperties}>
                <span>{r.name}</span>
                <span className="hd-muted">{r.date}</span>
              </li>
            ))}
          </ul>
          <p className="hd-fine">Example data added to this conversation only. Signing up is separate and connects nothing automatically.</p>
        </div>
      )}
    </Widget>
  );
}

function MedsWidget({ state, dispatch, headingRef }: { state: DemoState; dispatch: (a: { type: "draftRefill"; id: string | null }) => void; headingRef: (el: HTMLHeadingElement | null) => void }) {
  const picked = MEDS.find((m) => m.id === state.refillDraft);
  return (
    <Widget flow="meds" title="Medication list" headingRef={headingRef}>
      <ul className="hd-meds">
        {MEDS.map((m) => (
          <li key={m.id}>
            <div>
              <strong>{m.name}</strong>
              <span className="hd-muted">{m.note}</span>
            </div>
            <button type="button" className="hd-btn hd-btn-ghost" aria-pressed={state.refillDraft === m.id} onClick={() => dispatch({ type: "draftRefill", id: state.refillDraft === m.id ? null : m.id })}>
              {state.refillDraft === m.id ? "Selected" : "Draft refill"}
            </button>
          </li>
        ))}
      </ul>
      <div className="hd-draft" aria-live="polite">
        {picked ? (
          <>
            <h5>Refill draft · {picked.name}</h5>
            <p>“Hello, I’d like to ask about a refill of {picked.name}.”</p>
            <p className="hd-flag"><strong>Draft only. No request was sent.</strong></p>
          </>
        ) : (
          <p className="hd-muted">Select a medication to see a simulated refill draft. Nothing is ever sent from this demo.</p>
        )}
      </div>
    </Widget>
  );
}

function CompareWidget({ headingRef }: { headingRef: (el: HTMLHeadingElement | null) => void }) {
  return (
    <Widget flow="compare" title="Two records, side by side" headingRef={headingRef}>
      <table className="hd-table">
        <thead>
          <tr>
            <th scope="col">Topic</th>
            <th scope="col">Riverside<br />Oct 14</th>
            <th scope="col">Lakeside<br />Nov 3</th>
          </tr>
        </thead>
        <tbody>
          {COMPARE_ROWS.map((r) => (
            <tr key={r.topic} className={r.a !== r.b ? "hd-diff" : undefined}>
              <th scope="row">{r.topic}</th>
              <td>{r.a}</td>
              <td>{r.b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hd-fine">Highlighted rows differ between the two notes. Fictional sample records.</p>
    </Widget>
  );
}

function LabWidget({ state, dispatch, headingRef }: { state: DemoState; dispatch: (a: { type: "confirmLab" }) => void; headingRef: (el: HTMLHeadingElement | null) => void }) {
  return (
    <Widget flow="lab" title={LAB_SAMPLE.name} headingRef={headingRef}>
      <p className="hd-muted">Collected {LAB_SAMPLE.collected} · preloaded sample, nothing was uploaded.</p>
      <ul className="hd-meds">
        {LAB_SAMPLE.rows.map((r) => (
          <li key={r.test}>
            <strong>{r.test}</strong>
            <span>{r.value}</span>
          </li>
        ))}
      </ul>
      {state.labConfirmed ? (
        <p className="hd-flag" role="status"><strong>Confirmed.</strong> Marked as reviewed in this demo only.</p>
      ) : (
        <button type="button" className="hd-btn" onClick={() => dispatch({ type: "confirmLab" })}>
          Looks right, confirm
        </button>
      )}
    </Widget>
  );
}

function DemoRun({ focusStart, signedIn }: { focusStart: boolean; signedIn: boolean }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [live, setLive] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const choicesRef = useRef<HTMLDivElement>(null);
  const headings = useRef<Partial<Record<Flow, HTMLElement | null>>>({});
  const focused = useRef<Flow | null>(null);

  const pending = pendingEntry(state);
  const choices = choicesFor(state);

  useEffect(() => {
    if (focusStart) choicesRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [focusStart]);

  // The beat: after a choice, Holo pauses briefly, then the widget appears.
  const pendingFlow = pending?.flow;
  useEffect(() => {
    if (!pendingFlow) return;
    const t = window.setTimeout(() => {
      dispatch({ type: "reveal", flow: pendingFlow });
      setLive(`${FLOW_LABEL[pendingFlow]} is ready.`);
    }, reduced() ? 0 : BEAT_MS);
    return () => window.clearTimeout(t);
  }, [pendingFlow]);

  const importing = state.importStage === "importing";
  useEffect(() => {
    if (!importing) return;
    const t = window.setTimeout(() => {
      dispatch({ type: "finishImport" });
      setLive("Sample records imported. Fictional example data only; nothing came from UCSF.");
    }, reduced() ? 0 : IMPORT_MS);
    return () => window.clearTimeout(t);
  }, [importing]);

  // Bring a newly revealed widget into view inside the thread only (never the page) and move focus to it.
  const lastRevealed = [...state.entries].reverse().find((e) => e.revealed)?.flow;
  useEffect(() => {
    if (!lastRevealed || focused.current === lastRevealed) return;
    focused.current = lastRevealed;
    const box = thread.current;
    const heading = headings.current[lastRevealed];
    const widget = heading?.closest<HTMLElement>(".hd-widget");
    if (box && widget) {
      const top = widget.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
      box.scrollTo({ top, behavior: reduced() ? "auto" : "smooth" });
    }
    heading?.focus({ preventScroll: true });
  }, [lastRevealed]);

  const choose = useCallback((flow: Flow) => {
    dispatch({ type: "choose", flow });
    setLive(`You chose: ${FLOW_LABEL[flow]}. Holo is preparing it.`);
    // Keep focus inside the demo while the clicked button leaves the list.
    choicesRef.current?.focus({ preventScroll: true });
  }, []);

  const setHeading = (flow: Flow) => (el: HTMLHeadingElement | null) => {
    headings.current[flow] = el;
  };

  const progress = progressFor(state);
  const doneCount = progress.filter((p) => p.done).length;
  const briefDone = progress[0].done;

  return (
    <>
      <div className="hd-progress" role="group" aria-label={`Progress: ${doneCount} of ${progress.length} steps shown`}>
        {progress.map((p) => (
          <span key={p.id} className="hd-chip" data-done={p.done}>
            <span aria-hidden="true">{p.done ? "✓" : "○"}</span> {p.label}
            <span className="hd-sr">{p.done ? " done" : " not yet"}</span>
          </span>
        ))}
      </div>

      <div className="hd-thread" ref={thread} tabIndex={0} role="region" aria-label="Demo conversation">
        <Holo>
          Hi, I’m Holo. Alex has a visit coming up and a new message from the care team.
        </Holo>
        <section className="hd-card hd-appts" aria-label="Upcoming appointment">
          <h3>Upcoming appointment</h3>
          <ul>
            <li>
              <span className="hd-when">{NEXT_VISIT.date}<br />{NEXT_VISIT.time}</span>
              <span>{NEXT_VISIT.what}</span>
              <span className="hd-muted">{NEXT_VISIT.where}</span>
            </li>
          </ul>
        </section>
        <details className="hd-card hd-followup" onToggle={(event) => {
          if (event.currentTarget.open) dispatch({ type: "markRead" });
        }}>
          <summary aria-label={`Message from the care team: ${FOLLOW_UP.subject}`}>
            <span>
              <strong>{FOLLOW_UP.subject}</strong>
              <span className="hd-muted">{FOLLOW_UP.from}</span>
            </span>
            <span className="hd-badge" data-read={state.followUpRead}>{state.followUpRead ? "Read" : "New"}</span>
          </summary>
          <p className="hd-muted hd-received">{FOLLOW_UP.received}</p>
          <p>{FOLLOW_UP.body}</p>
        </details>

        {state.entries.map((entry) => (
          <div key={entry.flow} className="hd-entry" data-entry={entry.flow}>
            <div className="hd-row hd-row-you">
              <div className="hd-bubble hd-bubble-you">{FLOW_LABEL[entry.flow]}</div>
            </div>
            {entry.revealed ? (
              <>
                <Holo>{HOLO_LINE[entry.flow]}</Holo>
                {entry.flow === "prepare" && <BriefWidget state={state} headingRef={setHeading("prepare")} />}
                {entry.flow === "connect" && (
                  <ConnectWidget
                    state={state}
                    onImport={() => {
                      headings.current.connect?.focus({ preventScroll: true });
                      dispatch({ type: "startImport" });
                      setLive("Importing sample records.");
                    }}
                    headingRef={setHeading("connect")}
                  />
                )}
                {entry.flow === "meds" && <MedsWidget state={state} dispatch={dispatch} headingRef={setHeading("meds")} />}
                {entry.flow === "compare" && <CompareWidget headingRef={setHeading("compare")} />}
                {entry.flow === "lab" && <LabWidget state={state} dispatch={(action) => {
                  headings.current.lab?.focus({ preventScroll: true });
                  dispatch(action);
                }} headingRef={setHeading("lab")} />}
              </>
            ) : (
              <div className="hd-row hd-row-holo" aria-hidden="true">
                <HoloFace small />
                <div className="hd-bubble hd-bubble-holo hd-dots"><i /><i /><i /></div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="hd-choices" ref={choicesRef} tabIndex={-1} role="group" aria-label="What would you like to do next?">
        {choices.length > 0 ? (
          choices.map((flow) => (
            <button key={flow} type="button" className="hd-choice" data-flow={flow} disabled={Boolean(pending)} onClick={() => choose(flow)}>
              {FLOW_LABEL[flow]}
            </button>
          ))
        ) : (
          <p className="hd-muted">That’s everything in this preview.</p>
        )}
      </div>

      <div className="hd-footer">
        <p>{briefDone ? "Your visit brief is ready." : "Want to try it with your own records?"}</p>
        <a className="hd-btn hd-btn-cta" href={signedIn ? "/app" : "/sign-up"}>
          {signedIn ? "Go to dashboard" : "Get early access"}
        </a>
      </div>

      <p className="hd-sr" role="status" aria-live="polite">{live}</p>
    </>
  );
}

export function HoloDemo({ signedIn }: { signedIn: boolean }) {
  const [run, setRun] = useState(0);
  return (
    <section className="wrap section hd" id="demo" tabIndex={-1} aria-labelledby="demo-title">
      <div className="hd-intro">
        <p className="eyebrow">Try the demo</p>
        <h2 id="demo-title">Meet Holo, before your next visit.</h2>
        <p className="hd-lede">
          Tap a choice to see how Holo can turn scattered notes into a short brief with sources. No sign-in, no uploads, nothing is saved or sent.
        </p>
      </div>
      <div className="hd-panel">
        <header className="hd-head">
          <HoloFace />
          <div>
            <strong>Holo</strong>
            <p className="hd-disclosure">Fictional records and simulated actions. Some workflows shown are previews.</p>
          </div>
          <button type="button" className="hd-btn hd-btn-ghost hd-restart" onClick={() => setRun((n) => n + 1)}>
            Restart demo
          </button>
        </header>
        <DemoRun key={run} focusStart={run > 0} signedIn={signedIn} />
      </div>
    </section>
  );
}
