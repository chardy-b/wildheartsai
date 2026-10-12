import { describe, expect, it } from "vitest";
import { applyRunEvents, createDetailReadGuard, createRequestLifecycle, currentToolStep, describeRunFailure, formatToolDuration, mergeOlderDetail, mergeOlderDetailIfCurrent, mergeUniqueById, retryTerminalHydration, toolActivityLabel, toolTimeline, type ActivityEvent, type ActivityPayload } from "./chat-client-state";

const event = (sequence: number, kind: string, text?: string) => ({
  sequence, kind, payload: { text }, createdAt: "2026-01-01T00:00:00Z",
});
const activityEvent = (sequence: number, kind: string, payload: ActivityPayload = {}): ActivityEvent => ({
  sequence, kind, payload, createdAt: "2026-01-01T00:00:00Z",
});

describe("chat client response ordering and run activity", () => {
  it("ignores an older detail response after a later read or conversation selection", () => {
    const guard = createDetailReadGuard();
    guard.select("conversation-a");
    const initialRead = guard.begin("conversation-a");
    const postSubmitRead = guard.begin("conversation-a");
    expect(guard.isLatest(initialRead)).toBe(false);
    expect(guard.isLatest(postSubmitRead)).toBe(true);

    const otherConversation = guard.select("conversation-b");
    expect(guard.isSelected({ conversationId: "conversation-a", generation: initialRead.generation })).toBe(false);
    expect(guard.isSelected(otherConversation)).toBe(true);
  });

  it("keeps an in-flight detail read current when its selected conversation is clicked again", () => {
    const guard = createDetailReadGuard();
    guard.select("conversation-a");
    const pendingDetailRead = guard.begin("conversation-a");
    const sameSelection = guard.select("conversation-a");

    expect(sameSelection.generation).toBe(pendingDetailRead.generation);
    expect(guard.isLatest(pendingDetailRead)).toBe(true);
  });

  it("marks New Chat intent even when the initial selection is already null", () => {
    const guard = createDetailReadGuard();
    const initialListSelection = guard.snapshot();
    guard.reset();

    expect(guard.snapshot().conversationId).toBeNull();
    expect(guard.isSelected(initialListSelection)).toBe(false);
  });

  it("clears the summary spinner when the latest refresh fails without letting an older page clear a newer request", () => {
    const loadingStates: boolean[] = [];
    const lifecycle = createRequestLifecycle(loading => loadingStates.push(loading));
    const olderPage = lifecycle.begin();
    const latestRefresh = lifecycle.begin();

    expect(lifecycle.finish(olderPage)).toBe(false);
    expect(lifecycle.isLoading()).toBe(true);
    // The latest refresh uses this same finish path from finally, including on failure.
    expect(lifecycle.finish(latestRefresh)).toBe(true);
    expect(lifecycle.isLoading()).toBe(false);
    expect(loadingStates).toEqual([true, true, false]);
  });

  it("merges older message pages in sequence order without replacing fresh detail or duplicating ids", () => {
    const current = {
      conversation: { id: "conversation-a", title: "Fresh title" },
      messages: [
        { id: "m21", sequence: 21, role: "user", content: "latest question", createdAt: "2026-01-01", truncated: false },
        { id: "m22", sequence: 22, role: "assistant", content: "latest answer", createdAt: "2026-01-01", truncated: false },
      ],
      runs: [{ id: "new-run", status: "running" }],
      hasMore: true,
      nextBefore: 20,
    };
    const olderPage = {
      conversation: { id: "conversation-a", title: "Stale title" },
      messages: [
        { id: "m19", sequence: 19, role: "user", content: "old question", createdAt: "2025-12-01", truncated: false },
        { id: "m21", sequence: 21, role: "user", content: "stale copy", createdAt: "2025-12-01", truncated: false },
        { id: "m20", sequence: 20, role: "assistant", content: "old answer", createdAt: "2025-12-01", truncated: true },
      ],
      runs: [{ id: "old-run", status: "completed" }],
      hasMore: true,
      nextBefore: 18,
    };

    const merged = mergeOlderDetail(current, olderPage);
    expect(merged.messages.map(message => message.id)).toEqual(["m19", "m20", "m21", "m22"]);
    expect(merged.messages.find(message => message.id === "m21")?.content).toBe("latest question");
    expect(merged.conversation.title).toBe("Fresh title");
    expect(merged.runs).toEqual([{ id: "new-run", status: "running" }]);
    expect(merged.nextBefore).toBe(18);
    expect(mergeUniqueById([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]).map(item => item.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps an in-flight latest detail read valid during an older-page merge and rejects the page after selection changes", () => {
    const guard = createDetailReadGuard();
    guard.select("conversation-a");
    const currentRead = guard.begin("conversation-a");
    const olderPageSelection = guard.snapshot();
    const current = { conversation: { id: "conversation-a" }, messages: [{ id: "new", sequence: 3 }], runs: [{ id: "active", status: "running" }], hasMore: true, nextBefore: 2 as number | null };
    const page = { messages: [{ id: "old", sequence: 1 }], hasMore: false, nextBefore: null as number | null };
    const merged = mergeOlderDetailIfCurrent(current, page, () => guard.isSelected(olderPageSelection));
    expect(merged?.messages.map(message => message.id)).toEqual(["old", "new"]);
    expect(guard.isLatest(currentRead)).toBe(true);
    expect(merged?.runs).toEqual([{ id: "active", status: "running" }]);

    guard.select("conversation-b");
    expect(guard.isLatest(currentRead)).toBe(false);
    expect(mergeOlderDetailIfCurrent(current, page, () => guard.isSelected(olderPageSelection))).toBeNull();
  });

  it("keeps partial answers and trace cursors separated by run and replays later events", () => {
    let state = applyRunEvents(new Map(), "run-one", [event(1, "answer.delta", "old")], 2);
    state = applyRunEvents(state, "run-two", [event(1, "answer.delta", "new"), event(2, "tool.started")], 3);
    expect(state.get("run-one")?.answer).toBe("old");
    expect(state.get("run-two")?.answer).toBe("");

    state = applyRunEvents(state, "run-one", [event(2, "answer.delta", " answer"), event(3, "tool.completed")], 4);
    expect(state.get("run-one")).toMatchObject({ cursor: 3, answer: "old answer", events: [{ sequence: 3, kind: "tool.completed" }] });
    expect(state.get("run-two")?.cursor).toBe(2);
  });

  it("replays reasoning and joins tool start/completion by call id without exposing the id", () => {
    const events = [
      activityEvent(4, "answer.delta", { text: "The result is ready." }),
      activityEvent(3, "tool.completed", { toolCallId: "private-call-id", tool: "find_records", status: "completed", durationMs: 2300 }),
      activityEvent(2, "reasoning.delta", { text: "I will check the available records first." }),
      activityEvent(1, "tool.started", { toolCallId: "private-call-id", tool: "find_records" }),
    ];
    const activity = applyRunEvents(new Map(), "run-one", events, 5).get("run-one");

    expect(activity).toMatchObject({ answer: "The result is ready.", thinking: "I will check the available records first.", thinkingTruncated: false });
    expect(activity?.events.map(item => item.kind)).toEqual(["tool.started", "tool.completed"]);
    const timeline = toolTimeline(activity?.events ?? []);
    expect(timeline).toEqual([{ key: "tool-1", label: "Finding relevant records", status: "completed", sequence: 1, durationMs: 2300 }]);
    expect(JSON.stringify(timeline)).not.toContain("private-call-id");
    expect(currentToolStep(activity?.events ?? [])).toBeNull();
    expect(formatToolDuration(2300)).toBe("2.3 seconds");
  });

  it("caps thinking to 32 KiB of UTF-8 and keeps the truncation note per run", () => {
    const longThinking = "💛".repeat(9000);
    const first = applyRunEvents(new Map(), "run-one", [activityEvent(1, "reasoning.delta", { text: longThinking })], 2);
    const activity = first.get("run-one");
    expect(new TextEncoder().encode(activity?.thinking).byteLength).toBe(32 * 1024);
    expect(activity?.thinkingTruncated).toBe(true);

    const second = applyRunEvents(first, "run-two", [activityEvent(1, "reasoning.delta", { text: "Different run." })], 2);
    expect(second.get("run-two")?.thinking).toBe("Different run.");
    expect(second.get("run-two")?.thinkingTruncated).toBe(false);
    expect(second.get("run-one")?.thinking).toBe(activity?.thinking);
  });

  it("shows a user-facing cause and location for failed runs without exposing raw codes", () => {
    const state = applyRunEvents(new Map(), "run-one", [activityEvent(1, "run.failed", { status: "failed", code: "tool_limit_reached", stage: "record_lookup" })], 2);
    expect(state.get("run-one")?.failure).toEqual({ code: "tool_limit_reached", stage: "record_lookup" });
    expect(describeRunFailure(state.get("run-one")?.failure)).toContain("record lookup limit");
    expect(describeRunFailure(state.get("run-one")?.failure)).toContain("shorter date range");
    expect(describeRunFailure(state.get("run-one")?.failure)).not.toContain("tool_limit_reached");
    expect(describeRunFailure({ code: "worker_timeout", stage: "inference" })).toContain("while generating the answer");
    expect(describeRunFailure({ code: "toString", stage: "constructor" })).toBe("This response could not be completed.");
    expect(toolActivityLabel("toString")).toBe("Checking information for your answer");
  });

  it("keeps legacy tool events readable when older events have no call ids or codes", () => {
    const state = applyRunEvents(new Map(), "legacy-run", [event(1, "tool.started"), event(2, "tool.completed")], 3);
    const activity = state.get("legacy-run");
    expect(activity?.thinking).toBe("");
    expect(activity?.failure).toBeUndefined();
    expect(toolTimeline(activity?.events ?? []).map(item => item.label)).toEqual([
      "Checking information for your answer",
      "Checking information for your answer",
    ]);
  });

  it("backs off terminal hydration failures and stops for a user retry after its attempt bound", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const controller = new AbortController();
    const outcome = await retryTerminalHydration({
      hydrate: async () => { attempts += 1; throw new Error("temporary read failure"); },
      isCurrent: () => true,
      signal: controller.signal,
      wait: async delay => { delays.push(delay); },
      maxAttempts: 5,
    });
    expect(outcome).toEqual({ status: "retry" });
    expect(attempts).toBe(5);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it("does not continue terminal hydration after selection changes during a retry wait", async () => {
    let current = true;
    let attempts = 0;
    const outcome = await retryTerminalHydration({
      hydrate: async () => { attempts += 1; throw new Error("temporary read failure"); },
      isCurrent: () => current,
      signal: new AbortController().signal,
      wait: async () => { current = false; },
      maxAttempts: 5,
    });
    expect(outcome).toEqual({ status: "stale" });
    expect(attempts).toBe(1);
  });
});
