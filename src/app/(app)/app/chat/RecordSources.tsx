"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordSourcePage, RecordSourceView } from "@/lib/chat/store";
import { ChatAnswer } from "./ChatPresentation";

export function RecordSource({ source, index, runId }: { source: RecordSourceView; index: number; runId: string }) {
  return <details className="chat-record-source" id={`source-${runId}-${source.id}`}>
    <summary><span className="chat-source-number">{index + 1}</span><span><strong>{source.title}</strong><small>{source.organization}{source.date ? ` · ${new Date(source.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` : ""}{source.kind === "note" ? " · Note" : ""}</small></span><span className="chat-disclosure" aria-hidden="true">⌄</span></summary>
    <div className="chat-record-source-body">
      {source.viaSummary && <p className="chat-source-note">Referenced by a saved health summary reviewed for this answer.</p>}
      {source.detail && <p>{source.detail}</p>}
      <dl className="chat-source-reference"><div><dt>FHIR reference</dt><dd>{source.reference}</dd></div>{source.version && <div><dt>Source version</dt><dd>{source.version}</dd></div>}</dl>
      {source.earlierVersion && <p className="chat-source-note">This is the earlier saved version reviewed for this answer. A newer version is now in your records.</p>}
      {source.sections.length > 0 && <dl className="chat-source-fields">{source.sections.map((section, i) => <div key={i}><dt>{section.label}</dt><dd>{section.values.join(" · ")}</dd></div>)}</dl>}
      {source.noteExcerpt && <div className="chat-source-excerpt"><h4>Note excerpt reviewed</h4><p>{source.noteExcerpt}</p></div>}
      {source.truncated && <p className="chat-source-note">Some saved fields or note text are shortened for display.</p>}
    </div>
  </details>;
}

/** Render inline references only for IDs backed by the authenticated run's read receipts. */
export function AnswerWithRecordSources({ runId, text }: { runId: string; text: string }) {
  const [sources, setSources] = useState<RecordSourceView[]>([]);
  const [nextAfter, setNextAfter] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const load = useCallback((after: number | null) => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    const read = async () => {
      let cursor = after;
      while (!controller.signal.aborted) {
        const response = await fetch(`/api/chat/v1/runs/${encodeURIComponent(runId)}/record-sources${cursor === null ? "" : `?after=${cursor}`}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("sources_unavailable");
        const page = await response.json() as RecordSourcePage;
        if (page.sources.length || !page.hasMore) return page;
        if (page.nextAfter === null || page.nextAfter <= (cursor ?? -1)) throw new Error("sources_invalid_cursor");
        cursor = page.nextAfter;
      }
    };
    return read().then(page => {
      if (!page || controller.signal.aborted) return;
      setSources(previous => after === null ? page.sources : [...previous, ...page.sources.filter(source => !previous.some(saved => saved.id === source.id && saved.kind === source.kind))]);
      setHasMore(page.hasMore); setNextAfter(page.nextAfter); setError(false);
    }).catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => {
      if (inFlight.current === controller) { inFlight.current = null; if (!controller.signal.aborted) setLoading(false); }
    });
  }, [runId]);
  useEffect(() => {
    void load(null);
    return () => { inFlight.current?.abort(); inFlight.current = null; };
  }, [load]);

  return <>
    <ChatAnswer text={text} references={sources.map((source, index) => ({ id: source.id, label: `Record ${index + 1}`, target: `source-${runId}-${source.id}` }))} onReference={() => setOpen(true)} />
    {(sources.length > 0 || error) && <details className="chat-record-sources" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Records consulted{sources.length > 0 ? ` · ${sources.length}${hasMore ? "+" : ""}` : ""}</summary>
      <p>Saved records reviewed while preparing this answer. Open a reference to see its FHIR details.</p>
      {sources.map((source, index) => <RecordSource key={`${source.kind}:${source.id}`} source={source} index={index} runId={runId} />)}
      {error && <p role="alert">Could not load record references. <button type="button" disabled={loading} onClick={() => { setLoading(true); void load(sources.length ? nextAfter : null); }}>Retry</button></p>}
      {hasMore && <button type="button" disabled={loading} onClick={() => { setLoading(true); void load(nextAfter); }}>{loading ? "Loading…" : "More record references"}</button>}
    </details>}
  </>;
}
