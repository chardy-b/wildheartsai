"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyRunEvents, createDetailReadGuard, createRequestLifecycle, mergeOlderDetailIfCurrent, mergeUniqueById, retryTerminalHydration, type RunActivities } from "./chat-client-state";

const CHAT_API = "/api/chat/v1";
const isActive = (run: Run) => ["queued", "running", "cancelling"].includes(run.status);
const isTerminal = (status: string) => ["completed", "failed", "cancelled", "interrupted"].includes(status);

type Conversation = { id: string; createdAt: string; title?: string };
type Message = { id: string; sequence: number; role: string; content: string; createdAt: string; truncated: boolean };
type Run = { id: string; status: string };
type Detail = { conversation: Conversation; messages: Message[]; runs: Run[]; hasMore: boolean; nextBefore: number | null };
type Summary = { id: string; text?: string; content?: { text?: string }; createdAt: string };
type RunEvent = { sequence: number; kind: string; payload: { tool?: string; status?: string; text?: string }; createdAt: string };
type ConversationPage = { conversations: Conversation[]; hasMore: boolean; nextCursor: string | null };
type SummaryPage = { summaries: Summary[]; hasMore: boolean; nextCursor: string | null };

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
  const [conversationsHasMore, setConversationsHasMore] = useState(false);
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [summariesHasMore, setSummariesHasMore] = useState(false);
  const [summaryCursor, setSummaryCursor] = useState<string | null>(null);
  const [loadingMoreSummaries, setLoadingMoreSummaries] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activities, setActivities] = useState<RunActivities>(() => new Map());
  const [terminalRefreshError, setTerminalRefreshError] = useState<string | null>(null);
  const [terminalRetry, setTerminalRetry] = useState(0);
  const [summaryRequestLifecycle] = useState(() => createRequestLifecycle(setLoadingMoreSummaries));
  const pending = useRef<{ conversationId: string; text: string; key: string } | null>(null);
  const activitiesRef = useRef(activities);
  const [detailGuard] = useState(createDetailReadGuard);
  const conversationRequestSequence = useRef(0);
  const latestConversationRequest = useRef(0);
  const conversationPagingGeneration = useRef(0);
  const olderDetailRequestSequence = useRef(0);
  const latestOlderDetailRequest = useRef(0);
  const loadingOlderMessagesRef = useRef(false);
  const loadingMoreConversationsRef = useRef(false);

  const refreshList = useCallback(async (options?: { before?: string; append?: boolean; selection?: ReturnType<typeof detailGuard.snapshot>; signal?: AbortSignal }) => {
    const request = ++conversationRequestSequence.current;
    latestConversationRequest.current = request;
    const path = options?.before ? `/conversations?before=${encodeURIComponent(options.before)}` : "/conversations";
    const result = await chatRequest<ConversationPage>(path);
    if (request !== latestConversationRequest.current || options?.signal?.aborted || (options?.selection && !detailGuard.isSelected(options.selection))) return null;
    setConversations(previous => options?.append ? mergeUniqueById(previous, result.conversations) : result.conversations);
    setConversationsHasMore(result.hasMore);
    setConversationCursor(result.nextCursor);
    if (!options?.append) {
      conversationPagingGeneration.current += 1;
      loadingMoreConversationsRef.current = false;
      setLoadingMoreConversations(false);
    }
    return result;
  }, [detailGuard]);

  const loadMoreConversations = async () => {
    if (!conversationsHasMore || !conversationCursor || loadingMoreConversationsRef.current) return;
    loadingMoreConversationsRef.current = true;
    setLoadingMoreConversations(true);
    const pageGeneration = ++conversationPagingGeneration.current;
    const selection = detailGuard.snapshot();
    try {
      await refreshList({ before: conversationCursor, append: true, selection });
    } catch {
      if (detailGuard.isSelected(selection)) setError("Could not load more saved chats.");
    } finally {
      if (pageGeneration === conversationPagingGeneration.current) {
        loadingMoreConversationsRef.current = false;
        setLoadingMoreConversations(false);
      }
    }
  };

  const requestDetail = useCallback(async (conversationId: string, before?: number) => {
    const token = detailGuard.begin(conversationId);
    try {
      const path = `/conversations/${encodeURIComponent(conversationId)}${before === undefined ? "" : `?before=${before}`}`;
      const result = await chatRequest<Detail>(path);
      return { token, result };
    } catch (error) {
      return { token, error };
    }
  }, [detailGuard]);

  const refreshDetail = useCallback(async (conversationId: string) => {
    const response = await requestDetail(conversationId);
    if (!detailGuard.isLatest(response.token)) return null;
    if ("error" in response) throw response.error;
    // A fresh latest page intentionally resets loaded older pages and their cursors.
    latestOlderDetailRequest.current = ++olderDetailRequestSequence.current;
    loadingOlderMessagesRef.current = false;
    setLoadingOlderMessages(false);
    setDetail(response.result);
    setTerminalRefreshError(null);
    return response.result;
  }, [detailGuard, requestDetail]);

  useEffect(() => {
    const initialSelection = detailGuard.snapshot();
    let live = true;
    const request = ++conversationRequestSequence.current;
    latestConversationRequest.current = request;
    void chatRequest<ConversationPage>("/conversations").then(result => {
      if (!live || request !== latestConversationRequest.current) return;
      setConversations(result.conversations);
      setConversationsHasMore(result.hasMore);
      setConversationCursor(result.nextCursor);
      if (detailGuard.isSelected(initialSelection)) {
        const initialId = result.conversations[0]?.id ?? null;
        detailGuard.select(initialId);
        setSelected(initialId);
      }
    }).catch(() => {
      if (live && request === latestConversationRequest.current) setError("Could not load saved chats. Please refresh to try again.");
    });
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
        // Installing a fresh latest page resets older pages and prevents stale page
        // cursors from surviving a new submission or terminal rehydration.
        latestOlderDetailRequest.current = ++olderDetailRequestSequence.current;
        loadingOlderMessagesRef.current = false;
        setLoadingOlderMessages(false);
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
                // Terminal rehydration installs a fresh latest page and resets any older-page cursor.
                latestOlderDetailRequest.current = ++olderDetailRequestSequence.current;
                loadingOlderMessagesRef.current = false;
                setLoadingOlderMessages(false);
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
    const request = summaryRequestLifecycle.begin();
    try {
      const result = await chatRequest<SummaryPage>("/summaries");
      if (!summaryRequestLifecycle.isCurrent(request)) return;
      setSummaries(result.summaries);
      setSummariesHasMore(result.hasMore);
      setSummaryCursor(result.nextCursor);
    }
    catch { if (summaryRequestLifecycle.isCurrent(request)) setError("Could not load saved summaries."); }
    finally { summaryRequestLifecycle.finish(request); }
  };

  const loadMoreSummaries = async () => {
    if (!summariesHasMore || !summaryCursor || summaryRequestLifecycle.isLoading()) return;
    const request = summaryRequestLifecycle.begin();
    try {
      const result = await chatRequest<SummaryPage>(`/summaries?before=${encodeURIComponent(summaryCursor)}`);
      if (!summaryRequestLifecycle.isCurrent(request)) return;
      setSummaries(previous => mergeUniqueById(previous, result.summaries));
      setSummariesHasMore(result.hasMore);
      setSummaryCursor(result.nextCursor);
    } catch {
      if (summaryRequestLifecycle.isCurrent(request)) setError("Could not load more saved summaries.");
    } finally {
      summaryRequestLifecycle.finish(request);
    }
  };

  const loadOlderMessages = async () => {
    if (!detail || !selected || !detail.hasMore || detail.nextBefore === null || loadingOlderMessagesRef.current) return;
    const conversationId = selected;
    const selection = detailGuard.snapshot();
    const before = detail.nextBefore;
    const request = ++olderDetailRequestSequence.current;
    latestOlderDetailRequest.current = request;
    loadingOlderMessagesRef.current = true;
    setLoadingOlderMessages(true);
    try {
      const page = await chatRequest<Detail>(`/conversations/${encodeURIComponent(conversationId)}?before=${before}`);
      if (request !== latestOlderDetailRequest.current || !detailGuard.isSelected(selection)) return;
      setDetail(current => {
        if (!current || current.conversation.id !== conversationId) return current;
        return mergeOlderDetailIfCurrent(current, page, () => detailGuard.isSelected(selection)) ?? current;
      });
    } catch {
      if (request === latestOlderDetailRequest.current && detailGuard.isSelected(selection)) setError("Could not load older messages.");
    } finally {
      if (request === latestOlderDetailRequest.current) {
        loadingOlderMessagesRef.current = false;
        setLoadingOlderMessages(false);
      }
    }
  };

  return <div className="health-chat">
    <aside aria-label="Saved chats"><button type="button" disabled={busy} onClick={() => { detailGuard.reset(); setSelected(null); setDetail(null); setError(""); setTerminalRefreshError(null); }}>New chat</button>
      <ul>{conversations.map(conversation => <li key={conversation.id}><button type="button" aria-pressed={conversation.id === selected} disabled={busy} onClick={() => { if (conversation.id === selected) return; detailGuard.select(conversation.id); setSelected(conversation.id); setDetail(null); setError(""); setTerminalRefreshError(null); }}>{conversation.title ?? "Health chat"}<small>{new Date(conversation.createdAt).toLocaleDateString()}</small></button></li>)}</ul>
      {conversationsHasMore && <button type="button" disabled={loadingMoreConversations} onClick={() => { void loadMoreConversations(); }}>{loadingMoreConversations ? "Loading…" : "Load more saved chats"}</button>}
    </aside>
    <div className="chat-body">
      {error && <p role="alert">{error}</p>}
      <div aria-label="Messages" className="chat-messages">{detail?.messages.map(message => <article key={message.id}><strong>{message.role === "user" ? "You" : "Wild Hearts"}</strong><p>{message.content}</p>{message.truncated && <p role="note">This saved message was shortened to fit the history page.</p>}</article>)}</div>
      {detail?.hasMore && <button type="button" disabled={loadingOlderMessages} onClick={() => { void loadOlderMessages(); }}>{loadingOlderMessages ? "Loading…" : "Load older messages"}</button>}
      {runActivity?.answer && detail?.runs.some(isActive) && !terminalRefreshPending && <article className="chat-partial"><strong>Wild Hearts</strong><p>{runActivity.answer}</p></article>}
      {detail?.runs.some(isActive) && !terminalRefreshPending && <p role="status">Working on your answer. You can leave and return later.</p>}
      {latestRun && ["failed", "cancelled", "interrupted"].includes(latestRun.status) && <div><p role="status">This response {latestRun.status === "interrupted" ? "was interrupted" : latestRun.status === "failed" ? "could not be completed" : "was cancelled"}.</p><button type="button" disabled={busy} onClick={() => { const question = detail?.messages.filter(message => message.role === "user").at(-1); if (question) { pending.current = null; setDraft(question.content); } }}>Retry this question</button></div>}
      <form onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="chat-message">Ask about your records</label><textarea id="chat-message" value={draft} maxLength={8000} onChange={event => setDraft(event.target.value)} rows={4} disabled={busy} /><button disabled={busy || !draft.trim() || !!detail?.runs.some(isActive)}>{busy ? "Sending…" : "Send"}</button></form>
      {detail?.runs.filter(run => isActive(run) && !(terminalRefreshPending && run.id === runId)).map(run => <button key={run.id} type="button" onClick={() => { void chatRequest(`/runs/${encodeURIComponent(run.id)}`, { method: "DELETE" }).catch(() => setError("Could not cancel the response.")); }}>Stop response</button>)}
      {terminalRefreshError === runId && <p role="alert">This response finished, but the saved conversation could not be refreshed. <button type="button" onClick={() => { setTerminalRefreshError(null); setTerminalRetry(value => value + 1); }}>Retry loading this response</button></p>}
      <details><summary>Sources and tool activity</summary>{runActivity?.events.length ? <ol>{runActivity.events.map(event => <li key={event.sequence}>{event.payload.tool ?? "Data lookup"}: {event.kind === "tool.started" ? "started" : event.payload.status ?? "completed"}</li>)}</ol> : <p>Record lookups will appear here when used.</p>}</details>
      <details onToggle={event => { if (event.currentTarget.open) void loadSummaries(); }}><summary>Saved health summaries</summary><p>Helpful summaries may be saved automatically for future chats. You can remove them here.</p>{summaries.map(summary => <article key={summary.id}><p>{summary.text ?? summary.content?.text ?? "Saved health summary"}</p><button type="button" onClick={() => { void chatRequest(`/summaries/${encodeURIComponent(summary.id)}`, { method: "DELETE" }).then(loadSummaries).catch(() => setError("Could not delete this summary.")); }}>Delete summary</button></article>)}{summariesHasMore && <button type="button" disabled={loadingMoreSummaries} onClick={() => { void loadMoreSummaries(); }}>{loadingMoreSummaries ? "Loading…" : "Load more summaries"}</button>}</details>
    </div>
  </div>;
}
