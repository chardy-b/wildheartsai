"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyRunEvents, createDetailReadGuard, createRequestLifecycle, mergeOlderDetailIfCurrent, mergeUniqueById, retryTerminalHydration, currentToolStep, describeRunFailure, type ActivityEvent, type RunActivities } from "./chat-client-state";
import { useModelWarmup, type ModelReadiness } from "./use-model-warmup";

import { ResearchSources } from "./ResearchSources";
import { ChatAnswer, ChatIcon, CopyAnswer, ToolActivity } from "./ChatPresentation";

const CHAT_API = "/api/chat/v1";
const isActive = (run: Run) => ["queued", "running", "cancelling"].includes(run.status);
const isTerminal = (status: string) => ["completed", "failed", "cancelled", "interrupted"].includes(status);

type Conversation = { id: string; createdAt: string; title?: string };
type Message = { id: string; sequence: number; role: string; content: string; createdAt: string; truncated: boolean };
type Run = { id: string; status: string; assistantMessageId?: string | null };
type Detail = { conversation: Conversation; messages: Message[]; runs: Run[]; hasMore: boolean; nextBefore: number | null };
type Summary = { id: string; text?: string; content?: { text?: string }; createdAt: string };
type RunEvent = ActivityEvent;
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
  const { readiness, requestWarmup } = useModelWarmup();
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
  const [loadingChats, setLoadingChats] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [reconnectingRun, setReconnectingRun] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyToggleRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const sendingRef = useRef(false);
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
    }).finally(() => { if (live) setLoadingChats(false); });
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

  const activeRun = detail?.runs.find(isActive);
  const activeStep = runActivity ? currentToolStep(runActivity.events) : null;
  const responding = !!activeRun && !terminalRefreshPending;

  useEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 200)}px`;
  }, [draft]);

  useEffect(() => {
    if (followOutput.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [detail, runActivity?.answer, runActivity?.events.length, runActivity?.thinking, busy]);

  const stop = async () => {
    if (!activeRun || stopping === activeRun.id) return;
    const id = activeRun.id;
    setStopping(id);
    try {
      await chatRequest(`/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
      setDetail(current => current ? { ...current, runs: current.runs.map(run => run.id === id && isActive(run) ? { ...run, status: "cancelling" } : run) } : current);
    } catch { setError("Could not stop the response. Try again."); }
    finally { setStopping(null); }
  };

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
          setReconnectingRun(null);
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
          setReconnectingRun(runId);
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
    if (sendingRef.current || busy || !text || loadingChats || (selected && !detail) || detail?.runs.some(isActive)) return;
    sendingRef.current = true;
    followOutput.current = true;
    // Warmup runs alongside the existing idempotent submission; never gate Send on readiness.
    requestWarmup();
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
      sendingRef.current = false;
      setBusy(false);
      textareaRef.current?.focus();
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

  const selectChat = (id: string | null) => {
    if (id === selected && id !== null) { setHistoryOpen(false); return; }
    if (id === null) requestWarmup();
    if (id === null) detailGuard.reset(); else detailGuard.select(id);
    setSelected(id); setDetail(null); setError(""); setTerminalRefreshError(null);
    setDraft(""); setHistoryOpen(false); followOutput.current = true; setShowJump(false);
    textareaRef.current?.focus();
  };
  const loadingConversation = loadingChats || (!!selected && !detail);
  const empty = !loadingConversation && !detail?.messages.length && !busy;
  const suggestions = ["Help me understand my recent lab results", "Summarize my health records", "Help me prepare for my next appointment"];

  return <div className="health-chat" data-history-open={historyOpen} onKeyDown={event => { if (event.key === "Escape" && historyOpen) { setHistoryOpen(false); historyToggleRef.current?.focus(); } }}>
    <aside className="chat-sidebar" id="chat-history" aria-label="Saved chats">
      <button className="chat-new" type="button" disabled={busy} onClick={() => selectChat(null)}><ChatIcon name="plus" />New chat</button>
      <div className="chat-sidebar-label">Your conversations</div>
      {loadingChats && <p className="chat-sidebar-empty" role="status">Loading your chats…</p>}
      {!loadingChats && !conversations.length && <p className="chat-sidebar-empty">Your conversations will appear here.</p>}
      <ul className="chat-history-list">{conversations.map(conversation => <li key={conversation.id}>
        <button type="button" aria-pressed={conversation.id === selected} disabled={busy} onClick={() => selectChat(conversation.id)}>
          <ChatIcon name="chat" /><span><span className="chat-history-title">{conversation.title || "Health chat"}</span><small>{new Date(conversation.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></span>
        </button>
      </li>)}</ul>
      {conversationsHasMore && <button className="chat-text-button" type="button" disabled={loadingMoreConversations} onClick={() => { void loadMoreConversations(); }}>{loadingMoreConversations ? "Loading…" : "More conversations"}</button>}
      <details className="chat-summaries" onToggle={event => { if (event.currentTarget.open) void loadSummaries(); }}>
        <summary>Saved health summaries</summary>
        <p>Helpful context saved for future chats. Remove a summary any time.</p>
        {loadingMoreSummaries && <p role="status">Loading summaries…</p>}
        {!loadingMoreSummaries && !summaries.length && <p>No saved summaries yet.</p>}
        {summaries.map(summary => <article key={summary.id}><p>{summary.text ?? summary.content?.text ?? "Saved health summary"}</p><button type="button" onClick={() => { void chatRequest(`/summaries/${encodeURIComponent(summary.id)}`, { method: "DELETE" }).then(loadSummaries).catch(() => setError("Could not delete this summary.")); }}>Delete summary</button></article>)}
        {summariesHasMore && <button type="button" disabled={loadingMoreSummaries} onClick={() => { void loadMoreSummaries(); }}>More summaries</button>}
      </details>
    </aside>
    <div className="chat-body">
      <header className="chat-header">
        <button ref={historyToggleRef} className="chat-history-toggle" type="button" aria-label="Toggle chat history" aria-expanded={historyOpen} aria-controls="chat-history" onClick={() => setHistoryOpen(value => !value)}><ChatIcon name="menu" /></button>
        <div><h1>Health chat</h1><span>Your records. A little more clarity.</span></div>
        <span className="chat-header-badge"><ChatIcon name="spark" />Wild Hearts</span>
      </header>
      <div className="chat-scroll" ref={scrollRef} onScroll={event => {
        const element = event.currentTarget;
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
        followOutput.current = nearBottom; setShowJump(!nearBottom);
      }}>
        <div className="chat-thread">
          <ModelReadinessNotice readiness={readiness} onRetry={requestWarmup} />
          {loadingConversation && <div className="chat-loading" role="status"><span className="chat-tool-indicator is-running" />Loading your conversation…</div>}
          {empty && <div className="chat-welcome">
            <div className="chat-welcome-mark"><ChatIcon name="spark" /></div>
            <p className="chat-eyebrow">A space to make sense of your health</p>
            <h2>What’s on your mind?</h2>
            <p>Explore your saved records, understand health research, or get ready for your next visit.</p>
            <div className="chat-suggestions">{suggestions.map((suggestion, i) => <button key={suggestion} type="button" onClick={() => { setDraft(suggestion); textareaRef.current?.focus(); }}><ChatIcon name={i === 0 ? "spark" : i === 1 ? "chat" : "plus"} /><span>{suggestion}</span><span aria-hidden="true">↗</span></button>)}</div>
          </div>}
          {detail?.hasMore && <button className="chat-older" type="button" disabled={loadingOlderMessages} onClick={() => { void loadOlderMessages(); }}>{loadingOlderMessages ? "Loading…" : "Load earlier messages"}</button>}
          <div aria-label="Messages" className="chat-messages">{detail?.messages.map(message => {
            const messageRun = message.role === "assistant" ? detail.runs.find(run => run.assistantMessageId === message.id) : undefined;
            const activity = messageRun ? activities.get(messageRun.id) : undefined;
            return <article className={`chat-message chat-message-${message.role === "user" ? "user" : "assistant"}`} key={message.id}>
              <div className="chat-message-author">{message.role !== "user" && <span className="chat-avatar"><ChatIcon name="spark" /></span>}{message.role === "user" ? "You" : "Wild Hearts"}</div>
              {activity && (activity.thinking || activity.thinkingTruncated) && <ThinkingDisclosure text={activity.thinking} truncated={activity.thinkingTruncated} />}
              {activity && <ToolActivity events={activity.events} active={false} />}
              <ChatAnswer text={message.content} />
              {message.truncated && <p className="chat-notice" role="note">This saved message was shortened to fit the history page.</p>}
              {messageRun && <><ResearchSources key={messageRun.id} runId={messageRun.id} /><CopyAnswer text={message.content} /></>}
            </article>;
          })}</div>
          {(busy || responding || (latestRun && isTerminal(latestRun.status) && !latestRun.assistantMessageId && !!runActivity && (!!runActivity.answer || !!runActivity.events.length || !!runActivity.thinking || runActivity.thinkingTruncated))) && <article className="chat-message chat-message-assistant chat-partial" aria-label="Current response">
            <div className="chat-message-author"><span className="chat-avatar"><ChatIcon name="spark" /></span>Wild Hearts</div>
            {!busy && runActivity && (runActivity.thinking || runActivity.thinkingTruncated) && <ThinkingDisclosure text={runActivity.thinking} truncated={runActivity.thinkingTruncated} />}
            {!busy && runActivity && <ToolActivity events={runActivity.events} active={responding} />}
            {!busy && runActivity?.answer && <ChatAnswer text={runActivity.answer} />}
            {(busy || responding) && <div className="chat-run-status" role="status"><span className="chat-status-dots" aria-hidden="true"><i /><i /><i /></span>{busy ? "Sending your message" : reconnectingRun === runId ? "Reconnecting to your response…" : activeRun?.status === "cancelling" || stopping === activeRun?.id ? "Stopping…" : activeRun?.status === "queued" && readiness.status !== "ready" ? "Waiting for the model" : activeRun?.status === "queued" ? "Waiting to start" : runActivity?.answer ? "Writing your answer" : activeStep ? `${activeStep}…` : "Thinking through your question"}</div>}
          </article>}
          {latestRun && ["failed", "cancelled", "interrupted"].includes(latestRun.status) && <div className="chat-notice"><p role="status">{latestRun.status === "cancelled" ? "Response stopped." : latestRun.status === "failed" ? describeRunFailure(runActivity?.failure) : "This response was interrupted."}</p><button type="button" disabled={busy} onClick={() => { const question = detail?.messages.filter(message => message.role === "user").at(-1); if (question) { pending.current = null; setDraft(question.content); textareaRef.current?.focus(); } }}>Retry question</button></div>}
          {terminalRefreshPending && <div className="chat-notice" role="alert">Your response finished, but could not be loaded. <button type="button" onClick={() => { setTerminalRefreshError(null); setTerminalRetry(value => value + 1); }}>Retry loading</button></div>}
        </div>
      </div>
      <div className="chat-composer-area">
        {showJump && <button className="chat-jump" type="button" onClick={() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; followOutput.current = true; setShowJump(false); }}><ChatIcon name="down" />Latest message</button>}
        {error && <div className="chat-error" role="alert">{error}{selected && !detail && <button type="button" onClick={() => { void refreshDetail(selected).then(() => setError("")).catch(() => setError("Could not load this conversation. Try again.")); }}>Retry loading</button>}</div>}
        <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
          <label className="chat-sr-only" htmlFor="chat-message">Message Wild Hearts</label>
          <textarea ref={textareaRef} id="chat-message" value={draft} maxLength={8000} placeholder="Ask about your records or health research…" onChange={event => setDraft(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!responding) event.currentTarget.form?.requestSubmit(); }
          }} rows={1} readOnly={busy} />
          <div className="chat-composer-toolbar"><span>{responding ? "You can leave and return to this chat." : <><span className="chat-keyboard-hint">Enter to send · Shift + Enter for a new line</span><span className="chat-mobile-hint">Ask a follow-up any time</span></>}</span>
            {responding ? <button className="chat-send chat-stop" type="button" aria-label="Stop" title="Stop" disabled={stopping === activeRun?.id || activeRun?.status === "cancelling"} onClick={() => { void stop(); }}><ChatIcon name="stop" /></button>
              : <button className="chat-send" type="submit" aria-label={busy ? "Sending message" : "Send message"} title="Send message" disabled={busy || loadingConversation || !draft.trim() || !!activeRun}><ChatIcon name="arrow" /></button>}
          </div>
        </form>
        <p className="chat-disclaimer">Wild Hearts can make mistakes. Check important details with your care team.</p>
      </div>
    </div>
  </div>;
}

export function ThinkingDisclosure({ text, truncated }: { text: string; truncated: boolean }) {
  return <details className="chat-thinking">
    <summary>Thinking</summary>
    {text && <p>{text}</p>}
    {truncated && <p role="note">Only the beginning of the assistant&apos;s working notes is shown.</p>}
  </details>;
}

export function ModelReadinessNotice({ readiness, onRetry }: { readiness: ModelReadiness; onRetry: () => void }) {
  const lastConfirmed = readiness.lastConfirmedAt === null
    ? null
    : new Date(readiness.lastConfirmedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (readiness.status === "ready") {
    return <section className="chat-model-readiness" aria-label="Model availability" role="status">
      <strong>Ready</strong>
      <p>{lastConfirmed ? `Last confirmed at ${lastConfirmed}.` : "The model was just confirmed ready."} It may unload later.</p>
    </section>;
  }

  if (readiness.checking && (readiness.status === "queued" || readiness.status === "running" || readiness.status === "idle")) {
    return <section className="chat-model-readiness" aria-label="Model availability" role="status">
      <strong>Loading model…</strong>
      <p>You can send a question while it loads.</p>
    </section>;
  }

  if (readiness.status === "failed") {
    return <section className="chat-model-readiness" aria-label="Model availability" role="status">
      <strong>Model warmup failed</strong>
      <p>{readiness.message ?? "The model could not be loaded. Your question can still be sent."}</p>
      <button type="button" onClick={onRetry}>Try loading again</button>
    </section>;
  }

  return <section className="chat-model-readiness" aria-label="Model availability">
    <strong>Model is idle</strong>
    <p>{readiness.message ?? "You can ask now; your answer may wait for the model."}</p>
    <button type="button" onClick={onRetry}>Load model</button>
  </section>;
}
