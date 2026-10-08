"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyRunEvents, createDetailReadGuard, retryTerminalHydration, type RunActivities } from "./chat-client-state";

const CHAT_API = "/api/chat/v1";
const isActive = (run: Run) => ["queued", "running", "cancelling"].includes(run.status);
const isTerminal = (status: string) => ["completed", "failed", "cancelled", "interrupted"].includes(status);

type Conversation = { id: string; createdAt: string; title?: string };
type Message = { id: string; role: string; content: string; createdAt: string };
type Run = { id: string; status: string };
type Detail = { conversation: Conversation; messages: Message[]; runs: Run[] };
type Summary = { id: string; text?: string; content?: { text?: string }; createdAt: string };
type RunEvent = { sequence: number; kind: string; payload: { tool?: string; status?: string; text?: string }; createdAt: string };

async function chatRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${CHAT_API}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Please sign in again." : "That request could not be completed. Try again.");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function waitForVisibility(signal: AbortSignal): Promise<void> {
  if (!document.hidden || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const onVisibilityChange = () => { if (!document.hidden) finish(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function wait(delay: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(finish, delay);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function HealthChat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activities, setActivities] = useState<RunActivities>(() => new Map());
  const [terminalRefreshError, setTerminalRefreshError] = useState<string | null>(null);
  const [terminalRetry, setTerminalRetry] = useState(0);
  const pending = useRef<{ conversationId: string; text: string; key: string } | null>(null);
  const activitiesRef = useRef(activities);
  const [detailGuard] = useState(createDetailReadGuard);

  const refreshList = useCallback(async (options?: { selection?: ReturnType<typeof detailGuard.snapshot>; signal?: AbortSignal }) => {
    const result = await chatRequest<{ conversations: Conversation[] }>("/conversations");
    if (options?.signal?.aborted || (options?.selection && !detailGuard.isSelected(options.selection))) return;
    setConversations(result.conversations);
  }, [detailGuard]);

  const requestDetail = useCallback(async (conversationId: string) => {
    const token = detailGuard.begin(conversationId);
    try {
      const result = await chatRequest<Detail>(`/conversations/${encodeURIComponent(conversationId)}`);
      return { token, result };
    } catch (error) {
      return { token, error };
    }
  }, [detailGuard]);

  const refreshDetail = useCallback(async (conversationId: string) => {
    const response = await requestDetail(conversationId);
    if (!detailGuard.isLatest(response.token)) return null;
    if ("error" in response) throw response.error;
    setDetail(response.result);
    setTerminalRefreshError(null);
    return response.result;
  }, [detailGuard, requestDetail]);

  useEffect(() => {
    let live = true;
    void chatRequest<{ conversations: Conversation[] }>("/conversations").then(result => {
      if (!live) return;
      setConversations(result.conversations);
      const initialId = result.conversations[0]?.id ?? null;
      detailGuard.select(initialId);
      setSelected(initialId);
    }).catch(() => { if (live) setError("Could not load saved chats. Please refresh to try again."); });
    return () => { live = false; };
  }, [detailGuard]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    void requestDetail(selected).then(response => {
      if (!live || !detailGuard.isLatest(response.token)) return;
      if ("error" in response) {
        setError("Could not refresh this chat. Your saved run will continue.");
      } else {
        setDetail(response.result);
        setTerminalRefreshError(null);
      }
    });
    return () => { live = false; };
  }, [selected, detailGuard, requestDetail]);

  const latestRun = detail?.runs[detail.runs.length - 1];
  const runId = latestRun?.id;
  const runStatus = latestRun?.status;
  const runActivity = runId ? activities.get(runId) : undefined;
  const terminalRefreshPending = terminalRefreshError === runId;

  // The server owns each run. This effect only replays its persisted events and can
  // pause freely when the tab is hidden or this component unmounts.
  useEffect(() => {
    if (!runId || !selected || !runStatus) return;
    const controller = new AbortController();
    const selection = detailGuard.snapshot();
    let delay = 1000;
    const poll = async () => {
      while (!controller.signal.aborted) {
        await waitForVisibility(controller.signal);
        if (controller.signal.aborted || !detailGuard.isSelected(selection)) return;
        try {
          const after = activitiesRef.current.get(runId)?.cursor ?? 0;
          const result = await chatRequest<{ events: RunEvent[]; status: string; nextSequence: number }>(
            `/runs/${encodeURIComponent(runId)}/events?after=${after}`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted || !detailGuard.isSelected(selection)) return;
          const next = applyRunEvents(activitiesRef.current, runId, result.events, result.nextSequence);
          if (next !== activitiesRef.current) {
            activitiesRef.current = next;
            setActivities(next);
          }
          if (result.events.length) {
            delay = 1000;
          } else {
            delay = Math.min(delay * 2, 8000);
          }

          if (isTerminal(result.status)) {
            const outcome = await retryTerminalHydration({
              hydrate: async () => {
                const response = await requestDetail(selected);
                if (controller.signal.aborted || !detailGuard.isSelected(selection) || !detailGuard.isLatest(response.token)) return null;
                if ("error" in response) throw response.error;
                setDetail(response.result);
                setTerminalRefreshError(null);
                return response.result;
              },
              isCurrent: () => !controller.signal.aborted && detailGuard.isSelected(selection),
              signal: controller.signal,
              wait,
            });
            if (outcome.status === "hydrated" && !controller.signal.aborted && detailGuard.isSelected(selection)) {
              await refreshList({ selection, signal: controller.signal });
              if (controller.signal.aborted || !detailGuard.isSelected(selection)) return;
            } else if (outcome.status === "retry" && !controller.signal.aborted && detailGuard.isSelected(selection)) {
              setTerminalRefreshError(runId);
            }
            return;
          }
        } catch {
          if (controller.signal.aborted || !detailGuard.isSelected(selection)) return;
          delay = Math.min(delay * 2, 8000);
        }
        await wait(delay, controller.signal);
      }
    };
    void poll();
    return () => controller.abort();
  }, [runId, runStatus, selected, terminalRetry, detailGuard, requestDetail, refreshList]);

  const send = async () => {
    const text = draft.trim();
    if (busy || !text || detail?.runs.some(isActive)) return;
    setBusy(true);
    setError("");
    try {
      let conversationId = selected;
      if (!conversationId) {
        const created = await chatRequest<{ conversation: Conversation }>("/conversations", { method: "POST", body: "{}" });
        conversationId = created.conversation.id;
        detailGuard.select(conversationId);
        setSelected(conversationId);
        setDetail(null);
      }
      if (!pending.current || pending.current.conversationId !== conversationId || pending.current.text !== text) {
        pending.current = { conversationId, text, key: crypto.randomUUID() };
      }
      const submitted = await chatRequest<{ runId: string }>(`/conversations/${encodeURIComponent(conversationId)}/runs`, {
        method: "POST",
        headers: { "Idempotency-Key": pending.current.key },
        body: JSON.stringify({ message: pending.current.text }),
      });
      const nextActivities = applyRunEvents(activitiesRef.current, submitted.runId, [], 1);
      activitiesRef.current = nextActivities;
      setActivities(nextActivities);
      pending.current = null;
      setDraft("");
      const initial = await refreshDetail(conversationId);
      await refreshList();
      if (!initial) setError("The response started, but this chat could not be refreshed. Select it again to reload.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send your message.");
    } finally {
      setBusy(false);
    }
  };

  const loadSummaries = async () => {
    try { setSummaries((await chatRequest<{ summaries: Summary[] }>("/summaries")).summaries); }
    catch { setError("Could not load saved summaries."); }
  };

  return <div className="health-chat">
    <aside aria-label="Saved chats"><button type="button" disabled={busy} onClick={() => { detailGuard.select(null); setSelected(null); setDetail(null); setError(""); setTerminalRefreshError(null); }}>New chat</button>
      <ul>{conversations.map(conversation => <li key={conversation.id}><button type="button" aria-pressed={conversation.id === selected} disabled={busy} onClick={() => { if (conversation.id === selected) return; detailGuard.select(conversation.id); setSelected(conversation.id); setDetail(null); setError(""); setTerminalRefreshError(null); }}>{conversation.title ?? "Health chat"}<small>{new Date(conversation.createdAt).toLocaleDateString()}</small></button></li>)}</ul>
    </aside>
    <div className="chat-body">
      {error && <p role="alert">{error}</p>}
      <div aria-label="Messages" className="chat-messages">{detail?.messages.map(message => <article key={message.id}><strong>{message.role === "user" ? "You" : "Wild Hearts"}</strong><p>{message.content}</p></article>)}</div>
      {runActivity?.answer && detail?.runs.some(isActive) && !terminalRefreshPending && <article className="chat-partial"><strong>Wild Hearts</strong><p>{runActivity.answer}</p></article>}
      {detail?.runs.some(isActive) && !terminalRefreshPending && <p role="status">Working on your answer. You can leave and return later.</p>}
      {latestRun && ["failed", "cancelled", "interrupted"].includes(latestRun.status) && <div><p role="status">This response {latestRun.status === "interrupted" ? "was interrupted" : latestRun.status === "failed" ? "could not be completed" : "was cancelled"}.</p><button type="button" disabled={busy} onClick={() => { const question = detail?.messages.filter(message => message.role === "user").at(-1); if (question) { pending.current = null; setDraft(question.content); } }}>Retry this question</button></div>}
      <form onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="chat-message">Ask about your records</label><textarea id="chat-message" value={draft} maxLength={8000} onChange={event => setDraft(event.target.value)} rows={4} disabled={busy} /><button disabled={busy || !draft.trim() || !!detail?.runs.some(isActive)}>{busy ? "Sending…" : "Send"}</button></form>
      {detail?.runs.filter(run => isActive(run) && !(terminalRefreshPending && run.id === runId)).map(run => <button key={run.id} type="button" onClick={() => { void chatRequest(`/runs/${encodeURIComponent(run.id)}`, { method: "DELETE" }).catch(() => setError("Could not cancel the response.")); }}>Stop response</button>)}
      {terminalRefreshError === runId && <p role="alert">This response finished, but the saved conversation could not be refreshed. <button type="button" onClick={() => { setTerminalRefreshError(null); setTerminalRetry(value => value + 1); }}>Retry loading this response</button></p>}
      <details><summary>Sources and tool activity</summary>{runActivity?.events.length ? <ol>{runActivity.events.map(event => <li key={event.sequence}>{event.payload.tool ?? "Data lookup"}: {event.kind === "tool.started" ? "started" : event.payload.status ?? "completed"}</li>)}</ol> : <p>Record lookups will appear here when used.</p>}</details>
      <details onToggle={event => { if (event.currentTarget.open) void loadSummaries(); }}><summary>Saved health summaries</summary><p>Helpful summaries may be saved automatically for future chats. You can remove them here.</p>{summaries.map(summary => <article key={summary.id}><p>{summary.text ?? summary.content?.text ?? "Saved health summary"}</p><button type="button" onClick={() => { void chatRequest(`/summaries/${encodeURIComponent(summary.id)}`, { method: "DELETE" }).then(loadSummaries).catch(() => setError("Could not delete this summary.")); }}>Delete summary</button></article>)}</details>
    </div>
  </div>;
}
