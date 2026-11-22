import { describe, expect, it } from "vitest";
import { A1C_QUESTION, A1C_SAMPLES, NEXT_VISIT, RESULTS, VISITS, briefFor, briefText, ferritinSamples, fmt } from "./demo-data";
import { choicesFor, initialState, keyOf, labelOf, pendingTurn, reducer, type DemoState, type Kind } from "./demo-state";

function open(state: DemoState, kind: Kind, arg?: string) {
  const selected = reducer(state, { type: "choose", kind, arg });
  return reducer(selected, { type: "reveal", key: keyOf({ kind, arg }) });
}

describe("the full-screen demo", () => {
  it("offers prep, medicines, records, UCSF, and chart summary from the start", () => {
    expect(choicesFor(initialState)).toEqual([
      { kind: "prep", arg: "gi" }, { kind: "result", arg: "a1c" }, { kind: "meds" }, { kind: "finder" }, { kind: "connect" }, { kind: "summary" },
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
    expect(ferritinSamples(review.docAdded)).toEqual([{ date: "25 May 2026", value: 22 }]);
    const added = reducer(review, { type: "confirmDoc" });
    expect(ferritinSamples(added.docAdded)).toEqual([{ date: "25 May 2026", value: 22 }, { date: "18 Nov 2026", value: 14 }]);
    expect(choicesFor(added)).toContainEqual({ kind: "result", arg: "outside" });
    expect(reducer(added, { type: "confirmDoc" })).toBe(added);
    expect(briefFor("gi", { added: added.docAdded, imported: false }).bring.map((line) => line.text).join()).toContain("14 ng/mL");
    expect(open(added, "result", "outside").turns.at(-1)?.key).toBe("result:outside");
  });

  it("offers the environmental panel as a choice with its own label", () => {
    expect(RESULTS.filter((r) => r.id === "allergy")).toHaveLength(1);
    expect(RESULTS.find((r) => r.id === "allergy")?.modality).toBe("Skin prick");
    expect(labelOf({ kind: "result", arg: "allergy" })).toBe("Environmental allergy panel");
    expect(open(initialState, "result", "allergy").turns.at(-1)?.key).toBe("result:allergy");
  });

  it.each([false, true])("adds the A1C question exactly once to the named next visit (brief already open: %s)", (briefOpen) => {
    let state = briefOpen ? open(initialState, "prep", NEXT_VISIT.id) : initialState;
    state = open(state, "result", "a1c");
    const added = reducer(state, { type: "addA1cQuestion" });
    expect(reducer(added, { type: "addA1cQuestion" })).toBe(added);
    expect(labelOf({ kind: "result", arg: "a1c" })).toBe("Is my A1C getting worse?");
    // Opening all later briefs must not change the target of this question.
    state = added;
    for (const v of VISITS) state = open(state, "prep", v.id);
    for (const v of VISITS) {
      const before = briefFor(v.id, { added: false, imported: false });
      const after = briefFor(v.id, { added: false, imported: false, a1cQuestionAdded: state.a1cQuestionAdded });
      expect(after.ask.filter((q) => q.text === A1C_QUESTION)).toHaveLength(v.id === NEXT_VISIT.id ? 1 : 0);
      expect(after.ask.slice(0, before.ask.length)).toEqual(before.ask);
      if (v.id === NEXT_VISIT.id) {
        expect(after.when).toBe("28 Nov 2026");
        for (const s of A1C_SAMPLES) {
          expect(after.ask.at(-1)?.source).toContain(fmt(s.source));
          expect(briefText(after)).toContain(fmt(s.source));
        }
        expect(briefText(after).split(A1C_QUESTION)).toHaveLength(2);
      }
    }
    expect(briefFor(NEXT_VISIT.id, { added: false, imported: false, a1cQuestionAdded: initialState.a1cQuestionAdded }).ask.some((q) => q.text === A1C_QUESTION)).toBe(false);
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
    expect(initialState).toMatchObject({ turns: [], importStage: "ready", refill: null, docAdded: false, followUpRead: false, a1cQuestionAdded: false });
  });
});
