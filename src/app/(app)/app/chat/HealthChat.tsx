"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Conversation = { id: string; createdAt: string; title?: string };
type Message = { id: string; role: string; content: string; createdAt: string };
type Run = { id: string; status: string };
type Detail = { conversation: Conversation; messages: Message[]; runs: Run[] };
type Summary = { id: string; text?: string; content?: { text?: string }; createdAt: string };
type Trace = { sequence: number; kind: string; payload: { tool?: string; status?: string; text?: string } };
const active = (run: Run) => ["queued", "running", "cancelling"].includes(run.status);

async function chatRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const ticketResponse = await fetch("/api/chat/ticket", { method: "POST", cache: "no-store" });
  if (!ticketResponse.ok) throw new Error(ticketResponse.status === 401 ? "Please sign in again." : "Chat is temporarily unavailable.");
  const ticket: { token: string; apiUrl: string } = await ticketResponse.json();
  const response = await fetch(`${ticket.apiUrl}${path}`, {
    ...init, cache: "no-store", credentials: "omit",
    headers: { ...init?.headers, Authorization: `Bearer ${ticket.token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!response.ok) throw new Error(response.status === 401 ? "Please sign in again." : "That request could not be completed. Try again.");
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function HealthChat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trace, setTrace] = useState<Trace[]>([]);
  const [streamedAnswer, setStreamedAnswer] = useState("");
  const pending = useRef<{ conversationId: string; text: string; key: string; runId?: string } | null>(null);
  const replay = useRef<{ runId: string; sequence: number }>({ runId: "", sequence: 0 });
  const refreshList = useCallback(async () => {
    const result = await chatRequest<{ conversations: Conversation[] }>("/v1/conversations");
    setConversations(result.conversations);
  }, []);
  useEffect(() => {
    let live = true;
    void chatRequest<{ conversations: Conversation[] }>("/v1/conversations").then(result => {
      if (!live) return;
      setConversations(result.conversations);
      setSelected(result.conversations[0]?.id ?? null);
    }).catch(() => { if (live) setError("Could not load saved chats. Please refresh to try again."); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await chatRequest<Detail>(`/v1/conversations/${encodeURIComponent(selected)}`);
        if (!live) return;
        setDetail(result);
        if (pending.current?.runId && result.runs.some(run => run.id === pending.current?.runId)) pending.current = null;
        if (result.runs.some(active)) timer = setTimeout(load, 2000);
      } catch { if (live) { setError("Could not refresh this chat. Your saved run will continue."); timer = setTimeout(load, 5000); } }
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [selected, busy]);
  // Traces are replayed from the server. Unmounting aborts only this stream, never the run.
  const latestRun = detail?.runs[detail.runs.length - 1];
  const runId = latestRun?.id;
  const runStatus = latestRun?.status;
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout>;
    let wake: (() => void) | undefined;
    const listen = async () => {
      if (replay.current.runId !== runId) {
        replay.current = { runId, sequence: 0 };
        setStreamedAnswer(""); setTrace([]);
      }
      while (!controller.signal.aborted) {
       try {
        const ticket = await fetch("/api/chat/ticket", { method: "POST", cache: "no-store", signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.json(); });
        const response = await fetch(`${ticket.apiUrl}/v1/runs/${encodeURIComponent(runId)}/events`, { headers: { Authorization: `Bearer ${ticket.token}`, "Last-Event-ID": String(replay.current.sequence) }, cache: "no-store", credentials: "omit", signal: controller.signal });
        if (!response.ok || !response.body) throw new Error("stream_unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const event = JSON.parse(data) as Trace;
            if (!Number.isSafeInteger(event.sequence) || event.sequence <= replay.current.sequence) continue;
            replay.current.sequence = event.sequence;
            if (event.kind === "tool.started") setStreamedAnswer("");
            if (event.kind === "answer.delta" && typeof event.payload.text === "string") setStreamedAnswer(previous => previous + event.payload.text);
            if (event.kind.startsWith("tool.")) setTrace(previous => previous.some(e => e.sequence === event.sequence) ? previous : [...previous, event].slice(-200));
            if (["run.completed", "run.failed", "run.cancelled"].includes(event.kind)) { await reader.cancel(); return; }
          }
          if (buffer.length > 128_000) throw new Error("stream_event_too_large");
        }
       } catch { /* Reconnect with a fresh ticket and replay only unobserved events. */ }
       if (controller.signal.aborted || (runStatus && !["queued", "running", "cancelling"].includes(runStatus))) return;
       await new Promise<void>(resolve => { wake = resolve; retryTimer = setTimeout(resolve, 1000); });
      }
    };
    void listen();
    return () => { controller.abort(); clearTimeout(retryTimer); wake?.(); };
  }, [runId, runStatus]);
  const send = async () => {
    if (busy || !draft.trim() || detail?.runs.some(active)) return;
    setBusy(true); setError("");
    try {
      let conversationId = selected;
      if (!conversationId) {
        const created = await chatRequest<{ conversation: Conversation }>("/v1/conversations", { method: "POST", body: "{}" });
        conversationId = created.conversation.id;
        setSelected(conversationId); setDetail(null); setTrace([]);
      }
      if (!pending.current || pending.current.conversationId !== conversationId || pending.current.text !== draft.trim()) {
        pending.current = { conversationId, text: draft.trim(), key: crypto.randomUUID() };
      }
      const submitted = await chatRequest<{ runId: string }>(`/v1/conversations/${encodeURIComponent(conversationId)}/runs`, { method: "POST", headers: { "Idempotency-Key": pending.current.key }, body: JSON.stringify({ message: pending.current.text }) });
      pending.current.runId = submitted.runId; setDraft("");
      await refreshList();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not send your message."); }
    finally { setBusy(false); }
  };
  const loadSummaries = async () => {
    try { setSummaries((await chatRequest<{ summaries: Summary[] }>("/v1/summaries")).summaries); }
    catch { setError("Could not load saved summaries."); }
  };
  return <div className="health-chat">
    <aside aria-label="Saved chats"><button type="button" disabled={busy} onClick={() => { setSelected(null); setDetail(null); setTrace([]); setError(""); }}>New chat</button>
      <ul>{conversations.map(c => <li key={c.id}><button type="button" aria-pressed={c.id === selected} disabled={busy} onClick={() => { setSelected(c.id); setDetail(null); setTrace([]); }}>{c.title ?? "Health chat"}<small>{new Date(c.createdAt).toLocaleDateString()}</small></button></li>)}</ul>
    </aside>
    <div className="chat-body">
      {error && <p role="alert">{error}</p>}
      <div aria-label="Messages" className="chat-messages">{detail?.messages.map(message => <article key={message.id}><strong>{message.role === "user" ? "You" : "Wild Hearts"}</strong><p>{message.content}</p></article>)}</div>
      {streamedAnswer && detail?.runs.some(active) && <article className="chat-partial"><strong>Wild Hearts</strong><p>{streamedAnswer}</p></article>}
      {detail?.runs.some(active) && <p role="status">Working on your answer. You can leave and return later.</p>}
      {latestRun && ["failed", "cancelled", "interrupted"].includes(latestRun.status) && <div><p role="status">This response {latestRun.status === "interrupted" ? "was interrupted" : latestRun.status === "failed" ? "could not be completed" : "was cancelled"}.</p><button type="button" disabled={busy} onClick={() => { const question = detail?.messages.filter(message => message.role === "user").at(-1); if (question) { pending.current = null; setDraft(question.content); } }}>Retry this question</button></div>}
      <form onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="chat-message">Ask about your records</label><textarea id="chat-message" value={draft} maxLength={8000} onChange={event => setDraft(event.target.value)} rows={4} disabled={busy} /><button disabled={busy || !draft.trim() || !!detail?.runs.some(active)}>{busy ? "Sending…" : "Send"}</button></form>
      {detail?.runs.filter(active).map(r => <button key={r.id} type="button" onClick={() => { void chatRequest(`/v1/runs/${encodeURIComponent(r.id)}`, { method: "DELETE" }).catch(() => setError("Could not cancel the response.")); }}>Stop response</button>)}
      <details><summary>Sources and tool activity</summary>{trace.length ? <ol>{trace.map(event => <li key={event.sequence}>{event.payload.tool ?? "Data lookup"}: {event.kind === "tool.started" ? "started" : event.payload.status ?? "completed"}</li>)}</ol> : <p>Record lookups will appear here when used.</p>}</details>
      <details onToggle={event => { if (event.currentTarget.open) void loadSummaries(); }}><summary>Saved health summaries</summary><p>Helpful summaries may be saved automatically for future chats. You can remove them here.</p>{summaries.map(summary => <article key={summary.id}><p>{summary.text ?? summary.content?.text ?? "Saved health summary"}</p><button type="button" onClick={() => { void chatRequest(`/v1/summaries/${encodeURIComponent(summary.id)}`, { method: "DELETE" }).then(loadSummaries).catch(() => setError("Could not delete this summary.")); }}>Delete summary</button></article>)}</details>
    </div>
  </div>;
}
