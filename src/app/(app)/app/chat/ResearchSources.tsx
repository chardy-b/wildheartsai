"use client";

import { useEffect, useRef, useState } from "react";

type ResearchPassage = {
  sourceId: string;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
  truncated: boolean;
};
type ResearchOutput = { snapshotId: string } & (ResearchPassage | { hits: ResearchPassage[]; truncated: boolean });
type ResearchCall = { callOrder: number; tool: "search_research" | "read_research"; output: ResearchOutput };
type ResearchPage = { calls: ResearchCall[]; hasMore: boolean; nextAfter: number | null };

/** Shows the exact saved excerpt, with no HTML rendering or live repository requests. */
export function ResearchExcerpt({ passage, snapshotId }: { passage: ResearchPassage; snapshotId: string }) {
  return <article className="research-source">
    <h4>{passage.title}</h4>
    <p>{passage.path} · Lines {passage.startLine}–{passage.endLine}</p>
    <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{passage.excerpt}</p>
    {passage.truncated && <p role="note">This is a saved excerpt. Ask the assistant to read more of this source.</p>}
    <details><summary>Source reference</summary>
      <p style={{ overflowWrap: "anywhere" }}>Source: {passage.sourceId}</p>
      <p style={{ overflowWrap: "anywhere" }}>Research version: {snapshotId}</p>
    </details>
  </article>;
}

export function ResearchSources({ runId }: { runId: string }) {
  const [calls, setCalls] = useState<ResearchCall[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextAfter, setNextAfter] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => { inFlight.current?.abort(); }, []);

  async function load(append: boolean) {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    setError("");
    try {
      const cursor = append && nextAfter !== null ? `?after=${nextAfter}` : "";
      const response = await fetch(`/api/chat/v1/runs/${encodeURIComponent(runId)}/research-sources${cursor}`, {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error("research_sources_unavailable");
      const page = await response.json() as ResearchPage;
      if (controller.signal.aborted) return;
      setCalls(previous => append ? [...previous, ...page.calls.filter(call => !previous.some(saved => saved.callOrder === call.callOrder))] : page.calls);
      setHasMore(page.hasMore);
      setNextAfter(page.nextAfter);
      setLoaded(true);
    } catch {
      if (!controller.signal.aborted) setError("Could not load research sources. Try again.");
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }

  return <details>
    <summary>Research sources</summary>
    <p>Excerpts used for this answer are saved with your chat.</p>
    {!loaded && <button type="button" disabled={loading} onClick={() => { void load(false); }}>{loading ? "Loading…" : "View research sources"}</button>}
    {error && <p role="alert">{error} <button type="button" disabled={loading} onClick={() => { void load(loaded); }}>Retry</button></p>}
    {loaded && calls.length === 0 && <p>No research excerpts were used for this answer.</p>}
    {calls.map(call => <section key={call.callOrder} aria-label={call.tool === "search_research" ? "Research search results" : "Research source excerpt"}>
      {("hits" in call.output ? call.output.hits : [call.output]).map(passage => <ResearchExcerpt key={`${passage.sourceId}:${passage.offset}`} passage={passage} snapshotId={call.output.snapshotId} />)}
    </section>)}
    {loaded && hasMore && <button type="button" disabled={loading} onClick={() => { void load(true); }}>{loading ? "Loading…" : "Load more research sources"}</button>}
  </details>;
}
