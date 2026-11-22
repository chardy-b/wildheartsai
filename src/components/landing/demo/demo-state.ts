// State for the signed-out homepage demo. Pure and local: no network, storage or server imports.

export type Flow = "prepare" | "connect" | "meds" | "compare" | "lab";
export type ImportStage = "ready" | "importing" | "imported";

export type Entry = { flow: Flow; revealed: boolean };

export type DemoState = {
  entries: Entry[];
  importStage: ImportStage;
  /** id of the medication selected for the simulated refill draft */
  refillDraft: string | null;
  labConfirmed: boolean;
  followUpRead: boolean;
};

export type DemoAction =
  | { type: "choose"; flow: Flow }
  | { type: "reveal"; flow: Flow }
  | { type: "startImport" }
  | { type: "finishImport" }
  | { type: "draftRefill"; id: string | null }
  | { type: "confirmLab" }
  | { type: "markRead" };

export const initialState: DemoState = {
  entries: [],
  importStage: "ready",
  refillDraft: null,
  labConfirmed: false,
  followUpRead: false,
};

export const FLOW_LABEL: Record<Flow, string> = {
  prepare: "Prepare for the visit",
  connect: "Connect MyChart UCSF",
  meds: "Review meds & refills",
  compare: "Compare the two clinic records",
  lab: "Review the outside lab report",
};

export function pendingEntry(state: DemoState): Entry | undefined {
  return state.entries.find((entry) => !entry.revealed);
}

export function has(state: DemoState, flow: Flow): boolean {
  return state.entries.some((entry) => entry.flow === flow);
}

/** Choices still on offer. The three main ones stay until used; the rest follow the brief. */
export function choicesFor(state: DemoState): Flow[] {
  const choices: Flow[] = ["prepare", "connect", "meds"];
  if (has(state, "prepare")) choices.push("compare", "lab");
  return choices.filter((flow) => !has(state, flow));
}

export function progressFor(state: DemoState) {
  const revealed = (flow: Flow) => state.entries.some((entry) => entry.flow === flow && entry.revealed);
  return [
    { id: "brief", label: "Visit brief", done: revealed("prepare") },
    { id: "records", label: "Sample records", done: state.importStage === "imported" },
    { id: "meds", label: "Meds reviewed", done: revealed("meds") },
  ];
}

export function reducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "choose":
      // One beat at a time, and each widget appears once.
      if (pendingEntry(state) || has(state, action.flow)) return state;
      return { ...state, entries: [...state.entries, { flow: action.flow, revealed: false }] };
    case "reveal":
      return {
        ...state,
        entries: state.entries.map((entry) => (entry.flow === action.flow ? { ...entry, revealed: true } : entry)),
      };
    case "startImport":
      return state.importStage === "ready" ? { ...state, importStage: "importing" } : state;
    case "finishImport":
      return state.importStage === "importing" ? { ...state, importStage: "imported" } : state;
    case "draftRefill":
      return { ...state, refillDraft: action.id };
    case "confirmLab":
      return { ...state, labConfirmed: true };
    case "markRead":
      return state.followUpRead ? state : { ...state, followUpRead: true };
  }
}
