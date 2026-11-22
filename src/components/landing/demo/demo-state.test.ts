import { describe, expect, it } from "vitest";
import { RESULTS, VISITS, briefFor } from "./demo-data";
import { choicesFor, initialState, keyOf, pendingTurn, reducer, type DemoState, type Kind } from "./demo-state";

function open(state: DemoState, kind: Kind, arg?: string) {
  const selected = reducer(state, { type: "choose", kind, arg });
  return reducer(selected, { type: "reveal", key: keyOf({ kind, arg }) });
}

describe("the full-screen demo", () => {
  it("offers prep, medicines, records, UCSF, and chart summary from the start", () => {
    expect(choicesFor(initialState)).toEqual([
      { kind: "prep", arg: "gi" }, { kind: "meds" }, { kind: "finder" }, { kind: "connect" }, { kind: "summary" },
    ]);
  });

  it("allows all appointments and results without duplicating their turns", () => {
    let state = initialState;
    for (const visit of VISITS) {
      state = open(state, "prep", visit.id);
      expect(state.turns.at(-1)?.key).toBe(`prep:${visit.id}`);
      expect(briefFor(visit.id, { added: false, imported: false }).sub).toContain(visit.person);
    }
    state = open(state, "finder");
    for (const record of RESULTS) {
      state = open(state, "result", record.id);
      expect(state.turns.at(-1)?.key).toBe(`result:${record.id}`);
    }
    expect(reducer(state, { type: "choose", kind: "prep", arg: "gi" })).toBe(state);
  });

  it("waits for a turn to reveal before adding the next one", () => {
    const selected = reducer(initialState, { type: "choose", kind: "prep", arg: "gi" });
    expect(pendingTurn(selected)?.key).toBe("prep:gi");
    expect(reducer(selected, { type: "choose", kind: "meds" })).toBe(selected);
    expect(pendingTurn(reducer(selected, { type: "reveal", key: "prep:gi" }))).toBeUndefined();
  });

  it("shows the outside result and updates existing briefs only after confirmation", () => {
    const outside = { type: "choose", kind: "result", arg: "outside" } as const;
    const review = open(initialState, "doc");
    expect(reducer(review, outside)).toBe(review);
    const added = reducer(review, { type: "confirmDoc" });
    expect(choicesFor(added)).toContainEqual({ kind: "result", arg: "outside" });
    expect(reducer(added, { type: "confirmDoc" })).toBe(added);
    expect(briefFor("gi", { added: added.docAdded, imported: false }).bring.map((line) => line.text).join()).toContain("14 ng/mL");
    expect(open(added, "result", "outside").turns.at(-1)?.key).toBe("result:outside");
  });

  it("returns to an untouched starting state after an import, a draft and a message read", () => {
    const connect = open(initialState, "connect");
    expect(reducer(connect, { type: "finishImport" })).toBe(connect);
    const importing = reducer(connect, { type: "startImport" });
    const imported = reducer(importing, { type: "finishImport" });
    expect(importing.importStage).toBe("importing");
    expect(imported.importStage).toBe("imported");
    expect(reducer(imported, { type: "startImport" })).toBe(imported);
    const draft = reducer(reducer(imported, { type: "draftRefill", id: "omeprazole" }), { type: "markRead" });
    expect(draft).toMatchObject({ refill: "omeprazole", followUpRead: true });
    expect(initialState).toMatchObject({ turns: [], importStage: "ready", refill: null, docAdded: false, followUpRead: false });
  });
});
