export type SelectionSnapshot = { conversationId: string | null; generation: number };
export type DetailRequestToken = SelectionSnapshot & { request: number };

export function createRequestLifecycle(onLoadingChange: (loading: boolean) => void) {
  let sequence = 0;
  let latest = 0;
  let loading = false;
  return {
    begin(): number {
      latest = ++sequence;
      loading = true;
      onLoadingChange(true);
      return latest;
    },
    isCurrent(request: number): boolean {
      return request === latest;
    },
    isLoading(): boolean {
      return loading;
    },
    finish(request: number): boolean {
      if (request !== latest) return false;
      loading = false;
      onLoadingChange(false);
      return true;
    },
  };
}

export function createDetailReadGuard() {
  let conversationId: string | null = null;
  let generation = 0;
  let request = 0;
  let latestRequest = 0;

  return {
    select(nextConversationId: string | null): SelectionSnapshot {
      if (nextConversationId === conversationId) return { conversationId, generation };
      conversationId = nextConversationId;
      generation += 1;
      latestRequest = ++request;
      return { conversationId, generation };
    },
    reset(): SelectionSnapshot {
      conversationId = null;
      generation += 1;
      latestRequest = ++request;
      return { conversationId, generation };
    },
    snapshot(): SelectionSnapshot {
      return { conversationId, generation };
    },
    begin(conversationIdForRequest: string): DetailRequestToken {
      const token = { conversationId: conversationIdForRequest, generation, request: ++request };
      latestRequest = token.request;
      return token;
    },
    isSelected(snapshot: SelectionSnapshot): boolean {
      return snapshot.conversationId === conversationId && snapshot.generation === generation;
    },
    isLatest(token: DetailRequestToken): boolean {
      return token.conversationId === conversationId && token.generation === generation && token.request === latestRequest;
    },
  };
}

export type ActivityPayload = {
  text?: string;
  truncated?: boolean;
  tool?: string;
  toolCallId?: string;
  status?: string;
  durationMs?: number;
  code?: string;
  stage?: string;
};
export type ActivityEvent = { sequence: number; kind: string; payload: ActivityPayload; createdAt: string };
export type RunFailure = { code?: string; stage?: string };
export type RunActivity = { cursor: number; answer: string; thinking: string; thinkingTruncated: boolean; events: ActivityEvent[]; failure?: RunFailure };
export type RunActivities = Map<string, RunActivity>;

const MAX_THINKING_BYTES = 32 * 1024;
const utf8Encoder = new TextEncoder();

function appendBoundedUtf8(current: string, addition: string): { value: string; truncated: boolean } {
  let bytes = utf8Encoder.encode(current).byteLength;
  if (bytes >= MAX_THINKING_BYTES) return { value: current, truncated: addition.length > 0 };

  let suffix = "";
  for (const character of addition) {
    const size = utf8Encoder.encode(character).byteLength;
    if (bytes + size > MAX_THINKING_BYTES) return { value: current + suffix, truncated: true };
    suffix += character;
    bytes += size;
  }
  return { value: current + suffix, truncated: false };
}

export type Identified = { id: string };

export function mergeUniqueById<T extends Identified>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map(item => item.id));
  const merged = [...existing];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

export type PagedDetail<TMessage extends { id: string; sequence: number }> = {
  conversation: { id: string };
  messages: TMessage[];
  runs: Run[];
  hasMore: boolean;
  nextBefore: number | null;
};

type Run = { id: string; status: string };

export function mergeOlderDetail<TMessage extends { id: string; sequence: number }, TDetail extends PagedDetail<TMessage>>(
  current: TDetail,
  olderPage: Pick<TDetail, "messages" | "hasMore" | "nextBefore">,
): TDetail {
  const byId = new Map(current.messages.map(message => [message.id, message]));
  for (const message of olderPage.messages) {
    const existing = byId.get(message.id);
    byId.set(message.id, existing ? { ...message, ...existing } : message);
  }
  return {
    ...current,
    messages: [...byId.values()].sort((a, b) => a.sequence - b.sequence),
    hasMore: olderPage.hasMore,
    nextBefore: olderPage.nextBefore,
  };
}

export function mergeOlderDetailIfCurrent<TMessage extends { id: string; sequence: number }, TDetail extends PagedDetail<TMessage>>(
  current: TDetail,
  olderPage: Pick<TDetail, "messages" | "hasMore" | "nextBefore">,
  isCurrent: () => boolean,
): TDetail | null {
  return isCurrent() ? mergeOlderDetail(current, olderPage) : null;
}

export function applyRunEvents(
  activities: RunActivities,
  runId: string,
  events: ActivityEvent[],
  nextSequence: number,
): RunActivities {
  const previous = activities.get(runId) ?? { cursor: 0, answer: "", thinking: "", thinkingTruncated: false, events: [] };
  let answer = previous.answer;
  let thinking = previous.thinking ?? "";
  let thinkingTruncated = previous.thinkingTruncated ?? false;
  let failure = previous.failure;
  const newEvents = events
    .filter(event => Number.isSafeInteger(event.sequence) && event.sequence > previous.cursor)
    .sort((left, right) => left.sequence - right.sequence);
  const traced = newEvents.filter(event => event.kind.startsWith("tool."));
  for (const event of newEvents) {
    if (event.kind === "tool.started") answer = "";
    if (event.kind === "answer.delta" && typeof event.payload.text === "string") answer += event.payload.text;
    if (event.kind === "reasoning.delta") {
      if (typeof event.payload.text === "string") {
        const appended = appendBoundedUtf8(thinking, event.payload.text);
        thinking = appended.value;
        thinkingTruncated ||= appended.truncated;
      }
      thinkingTruncated ||= event.payload.truncated === true;
    }
    if (event.kind === "run.failed") {
      failure = {
        ...(typeof event.payload.code === "string" ? { code: event.payload.code } : {}),
        ...(typeof event.payload.stage === "string" ? { stage: event.payload.stage } : {}),
      };
    }
  }
  const cursor = Math.max(previous.cursor, nextSequence - 1, ...newEvents.map(event => event.sequence));
  if (!newEvents.length && cursor === previous.cursor) return activities;
  const bySequence = new Map(previous.events.map(event => [event.sequence, event]));
  for (const event of traced) bySequence.set(event.sequence, event);
  const next = new Map(activities);
  next.set(runId, {
    cursor,
    answer,
    thinking,
    thinkingTruncated,
    events: [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-200),
    ...(failure ? { failure } : {}),
  });
  return next;
}

const TOOL_LABELS: Record<string, string> = {
  get_data_coverage: "Checking which records are available",
  find_records: "Finding relevant records",
  read_records: "Reviewing selected records",
  read_stored_note: "Reading a stored note",
  calculate_lab_trend: "Comparing lab results",
  find_saved_summaries: "Checking saved summaries",
  save_summary: "Saving a helpful summary",
  search_research: "Searching trusted health sources",
  read_research: "Reviewing a health source",
};

export function toolActivityLabel(tool?: string): string {
  return tool && Object.prototype.hasOwnProperty.call(TOOL_LABELS, tool)
    ? TOOL_LABELS[tool]
    : "Checking information for your answer";
}

export type ToolActivity = {
  key: string;
  label: string;
  status: "running" | "completed" | "failed" | "rejected";
  sequence: number;
  durationMs?: number;
  failure?: RunFailure;
};

export function toolTimeline(events: ActivityEvent[]): ToolActivity[] {
  const calls = new Map<string, ToolActivity>();
  const rows: ToolActivity[] = [];
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.kind !== "tool.started" && event.kind !== "tool.completed") continue;
    const callId = event.payload.toolCallId;
    const current = callId ? calls.get(callId) : undefined;
    const label = event.payload.tool ? toolActivityLabel(event.payload.tool) : current?.label ?? "Checking information for your answer";
    if (event.kind === "tool.started") {
      const row: ToolActivity = { key: `tool-${event.sequence}`, label, status: "running", sequence: event.sequence };
      rows.push(row);
      if (callId) calls.set(callId, row);
      continue;
    }

    const status = event.payload.status === "failed" ? "failed" : event.payload.status === "rejected" ? "rejected" : "completed";
    const durationMs = typeof event.payload.durationMs === "number" && Number.isFinite(event.payload.durationMs)
      ? Math.min(300_000, Math.max(0, Math.trunc(event.payload.durationMs)))
      : undefined;
    const failure = {
      ...(typeof event.payload.code === "string" ? { code: event.payload.code } : {}),
      ...(typeof event.payload.stage === "string" ? { stage: event.payload.stage } : {}),
    };
    const completed: ToolActivity = {
      key: current?.key ?? `tool-${event.sequence}`,
      label,
      status,
      sequence: current?.sequence ?? event.sequence,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(Object.keys(failure).length ? { failure } : {}),
    };
    if (current) rows[rows.indexOf(current)] = completed;
    else rows.push(completed);
    if (callId) calls.set(callId, completed);
  }
  return rows.sort((left, right) => left.sequence - right.sequence);
}

const FAILURE_MESSAGES: Record<string, string> = {
  worker_failed: "The assistant stopped unexpectedly.",
  worker_timeout: "This response took too long to finish.",
  inference_unavailable: "The model could not be reached, so the response could not be finished.",
  tool_limit_reached: "The assistant reached its allowed number of tool steps before finishing.",
  tool_unavailable: "A tool needed for this answer was unavailable.",
  context_unavailable: "The assistant could not prepare the information for this answer.",
  event_publish_failed: "We could not save the latest progress for this answer.",
};

const FAILURE_STAGES: Record<string, string> = {
  context: "while preparing your question",
  inference: "while generating the answer",
  record_lookup: "while looking up your records",
  note_lookup: "while reading a stored note",
  research: "while checking health research",
  event_publish: "while saving progress",
  deadline: "when the time limit was reached",
};

export function describeRunFailure(failure?: RunFailure): string {
  const code = failure?.code;
  if (code === "tool_limit_reached" && failure?.stage === "record_lookup") {
    return "The assistant reached its record lookup limit before finishing. Try asking about one type of result or a shorter date range.";
  }
  const message = code && Object.prototype.hasOwnProperty.call(FAILURE_MESSAGES, code)
    ? FAILURE_MESSAGES[code]
    : "This response could not be completed.";
  const stage = failure?.stage && Object.prototype.hasOwnProperty.call(FAILURE_STAGES, failure.stage)
    ? FAILURE_STAGES[failure.stage]
    : undefined;
  return stage ? `${message.replace(/[.]$/, "")} ${stage}.` : message;
}

export function currentToolStep(events: ActivityEvent[]): string | null {
  const active = toolTimeline(events).filter(item => item.status === "running").at(-1);
  return active?.label ?? null;
}

export function formatToolDuration(durationMs?: number): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return "under a second";
  const seconds = durationMs / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)} seconds` : `${Math.round(seconds)} seconds`;
}

export async function retryTerminalHydration<T>(options: {
  hydrate: () => Promise<T | null>;
  isCurrent: () => boolean;
  signal: AbortSignal;
  wait: (delay: number, signal: AbortSignal) => Promise<void>;
  maxAttempts?: number;
}): Promise<{ status: "hydrated"; value: T } | { status: "stale" } | { status: "retry" }> {
  const maxAttempts = options.maxAttempts ?? 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal.aborted || !options.isCurrent()) return { status: "stale" };
    try {
      const value = await options.hydrate();
      if (options.signal.aborted || !options.isCurrent()) return { status: "stale" };
      if (value !== null) return { status: "hydrated", value };
    } catch {
      if (options.signal.aborted || !options.isCurrent()) return { status: "stale" };
    }
    if (attempt + 1 === maxAttempts) break;
    await options.wait(Math.min(1000 * 2 ** attempt, 8000), options.signal);
    if (options.signal.aborted || !options.isCurrent()) return { status: "stale" };
  }
  return options.signal.aborted || !options.isCurrent() ? { status: "stale" } : { status: "retry" };
}
