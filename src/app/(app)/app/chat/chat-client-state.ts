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

export type ActivityEvent = { sequence: number; kind: string; payload: { text?: string; tool?: string; status?: string }; createdAt: string };
export type RunActivity = { cursor: number; answer: string; events: ActivityEvent[] };
export type RunActivities = Map<string, RunActivity>;

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
  const previous = activities.get(runId) ?? { cursor: 0, answer: "", events: [] };
  let answer = previous.answer;
  const newEvents = events
    .filter(event => Number.isSafeInteger(event.sequence) && event.sequence > previous.cursor)
    .sort((left, right) => left.sequence - right.sequence);
  const traced = newEvents.filter(event => event.kind.startsWith("tool."));
  for (const event of newEvents) {
    if (event.kind === "tool.started") answer = "";
    if (event.kind === "answer.delta" && typeof event.payload.text === "string") answer += event.payload.text;
  }
  const cursor = Math.max(previous.cursor, nextSequence - 1, ...newEvents.map(event => event.sequence));
  if (!newEvents.length && cursor === previous.cursor) return activities;
  const bySequence = new Map(previous.events.map(event => [event.sequence, event]));
  for (const event of traced) bySequence.set(event.sequence, event);
  const next = new Map(activities);
  next.set(runId, { cursor, answer, events: [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-200) });
  return next;
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
