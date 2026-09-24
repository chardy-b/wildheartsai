export type EpicStage = "discovery" | "token" | "refresh" | "fhir";

// Messages carry only the stage, HTTP status and OAuth error code: never tokens or patient data.
export class EpicError extends Error {
  constructor(
    readonly stage: EpicStage,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(`Epic ${stage} failed${status ? ` (${status})` : ""}${code ? `: ${code}` : ""}`);
    this.name = "EpicError";
  }
}

export class ReconnectRequiredError extends Error {
  constructor() {
    super("The Epic connection needs to be reconnected");
    this.name = "ReconnectRequiredError";
  }
}
