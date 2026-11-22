import { describe, expect, it } from "vitest";
import { choicesFor, initialState, pendingEntry, progressFor, reducer, type DemoState } from "./demo-state";

const run = (...actions: Parameters<typeof reducer>[1][]): DemoState => actions.reduce(reducer, initialState);

describe("homepage demo state", () => {
  it("offers the three main choices first", () => {
    expect(choicesFor(initialState)).toEqual(["prepare", "connect", "meds"]);
  });

  it("adds a pending entry on choose, reveals it, and ignores repeats and overlapping choices", () => {
    const chosen = run({ type: "choose", flow: "prepare" });
    expect(pendingEntry(chosen)?.flow).toBe("prepare");
    expect(reducer(chosen, { type: "choose", flow: "meds" })).toBe(chosen);
    const revealed = reducer(chosen, { type: "reveal", flow: "prepare" });
    expect(pendingEntry(revealed)).toBeUndefined();
    expect(reducer(revealed, { type: "choose", flow: "prepare" })).toBe(revealed);
    expect(choicesFor(revealed)).toEqual(["connect", "meds", "compare", "lab"]);
    expect(progressFor(revealed)[0].done).toBe(true);
  });

  it("runs the sample import once, in order", () => {
    expect(reducer(initialState, { type: "finishImport" })).toBe(initialState);
    const importing = reducer(initialState, { type: "startImport" });
    expect(importing.importStage).toBe("importing");
    expect(reducer(importing, { type: "startImport" })).toBe(importing);
    const done = reducer(importing, { type: "finishImport" });
    expect(done.importStage).toBe("imported");
    expect(reducer(done, { type: "startImport" })).toBe(done);
  });

  it("keeps refill selection as a draft and confirms the lab sample", () => {
    const state = run({ type: "draftRefill", id: "omeprazole" }, { type: "confirmLab" }, { type: "markRead" });
    expect(state.refillDraft).toBe("omeprazole");
    expect(state.labConfirmed).toBe(true);
    expect(state.followUpRead).toBe(true);
  });

  it("restarts deterministically from the initial state", () => {
    const used = run({ type: "choose", flow: "connect" }, { type: "startImport" });
    expect(used).not.toEqual(initialState);
    expect(initialState).toEqual({ entries: [], importStage: "ready", refillDraft: null, labConfirmed: false, followUpRead: false });
  });
});
