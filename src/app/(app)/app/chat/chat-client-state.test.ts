import { describe, expect, it } from "vitest";
import { applyRunEvents, createDetailReadGuard, createRequestLifecycle, mergeOlderDetail, mergeOlderDetailIfCurrent, mergeUniqueById, retryTerminalHydration } from "./chat-client-state";

const event = (sequence: number, kind: string, text?: string) => ({
  sequence, kind, payload: { text }, createdAt: "2026-01-01T00:00:00Z",
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
