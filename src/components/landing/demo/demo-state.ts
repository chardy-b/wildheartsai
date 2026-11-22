// State for the public /demo page. Pure and local: no network, storage or server imports.

import { VISITS, visitOf } from "./demo-data";

export type Kind = "prep" | "meds" | "connect" | "finder" | "result" | "doc" | "summary";
export type ImportStage = "ready" | "importing" | "imported";

/** Something the person can ask for. "browse" only changes which choices are offered. */
export type Choice = { kind: Kind | "browse"; arg?: string };
export type Turn = { key: string; kind: Kind; arg?: string; revealed: boolean };

export type DemoState = {
  turns: Turn[];
  /** true shows the full set of starting choices instead of ones that follow the last widget */
  browse: boolean;
  importStage: ImportStage;
  /** id of the medication whose refill draft is open */
  refill: string | null;
  /** the sample document's ferritin has been confirmed and added */
  docAdded: boolean;
  followUpRead: boolean;
};

export type DemoAction =
  | { type: "choose"; kind: Kind; arg?: string }
  | { type: "reveal"; key: string }
  | { type: "browse" }
  | { type: "startImport" }
  | { type: "finishImport" }
  | { type: "draftRefill"; id: string | null }
  | { type: "confirmDoc" }
  | { type: "markRead" };

export const initialState: DemoState = {
  turns: [],
  browse: true,
  importStage: "ready",
  refill: null,
  docAdded: false,
  followUpRead: false,
};

export const keyOf = (c: { kind: string; arg?: string }) => (c.arg && c.kind !== "finder" ? `${c.kind}:${c.arg}` : c.kind);

export function labelOf(c: Choice): string {
  switch (c.kind) {
    case "prep": return `Prepare for ${visitOf(c.arg ?? "gi").short} visit`;
    case "meds": return "Review meds";
    case "connect": return "Connect MyChart UCSF";
    case "finder": return c.arg === "again" ? "Find another result" : "Find a result";
    case "result": return c.arg === "outside" ? "Ferritin from outside report" : c.arg === "ferritin" ? "Earlier ferritin" : c.arg === "biopsy" ? "Biopsy trend" : c.arg === "mri" ? "Brain MRI" : c.arg === "allergy" ? "Environmental allergy panel" : "Audiology";
    case "doc": return "Review outside report";
    case "summary": return "Chart summary";
    case "browse": return "All options";
  }
}

export const pendingTurn = (state: DemoState) => state.turns.find((t) => !t.revealed);
export const hasTurn = (state: DemoState, c: { kind: string; arg?: string }) => state.turns.some((t) => t.key === keyOf(c));

/** Visit to prepare next: the first one not yet prepared, else the last one prepared. */
export function nextPrep(state: DemoState): Choice {
  const done = state.turns.filter((t) => t.kind === "prep").map((t) => t.arg);
  const next = VISITS.find((v) => !done.includes(v.id));
  return { kind: "prep", arg: next?.id ?? done[done.length - 1] ?? "gi" };
}

const ROOT = (s: DemoState): Choice[] => [nextPrep(s), { kind: "meds" }, { kind: "finder" }, { kind: "connect" }, { kind: "summary" }];

/** Choices on offer: all starting choices, or only ones relevant to the last widget plus a way back. */
export function choicesFor(state: DemoState): Choice[] {
  const last = state.turns[state.turns.length - 1];
  if (state.browse || !last) return ROOT(state);
  const prep = nextPrep(state);
  const doc: Choice[] = state.docAdded ? [] : [{ kind: "doc" }];
  let next: Choice[];
  switch (last.kind) {
    case "prep": next = [...doc, { kind: "meds" }, { kind: "finder" }, { kind: "summary" }]; break;
    case "meds": next = [prep, { kind: "finder" }, { kind: "summary" }]; break;
    case "connect": next = [prep, { kind: "meds" }]; break;
    case "finder": next = [prep, ...doc, { kind: "summary" }]; break;
    case "result": next = [{ kind: "finder", arg: "again" }, prep, ...doc]; break;
    case "doc": next = state.docAdded ? [{ kind: "result", arg: "outside" }, prep] : [{ kind: "finder" }, prep]; break;
    case "summary": next = [prep, { kind: "finder" }, { kind: "meds" }]; break;
  }
  return [...next, { kind: "browse" }];
}

export function reducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "choose": {
      // One beat at a time, each widget appears once, and the outside result needs the confirmed document.
      if (pendingTurn(state) || hasTurn(state, action)) return state;
      if (action.kind === "result" && action.arg === "outside" && !state.docAdded) return state;
      const turn: Turn = { key: keyOf(action), kind: action.kind, arg: action.arg, revealed: false };
      return { ...state, browse: false, turns: [...state.turns, turn] };
    }
    case "reveal":
      return { ...state, turns: state.turns.map((t) => (t.key === action.key ? { ...t, revealed: true } : t)) };
    case "browse":
      return state.browse ? state : { ...state, browse: true };
    case "startImport":
      return state.importStage === "ready" ? { ...state, importStage: "importing" } : state;
    case "finishImport":
      return state.importStage === "importing" ? { ...state, importStage: "imported" } : state;
    case "draftRefill":
      return { ...state, refill: action.id };
    case "confirmDoc":
      return state.docAdded ? state : { ...state, docAdded: true };
    case "markRead":
      return state.followUpRead ? state : { ...state, followUpRead: true };
  }
}
