import { describe, expect, it } from "vitest";
import { applyRunEvents, createDetailReadGuard, retryTerminalHydration } from "./chat-client-state";

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
