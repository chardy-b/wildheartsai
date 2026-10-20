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

export type ReconnectReason = "missing_refresh_token" | "refresh_rejected" | "fhir_unauthorized";

export class ReconnectRequiredError extends Error {
  constructor(readonly reason: ReconnectReason = "fhir_unauthorized", readonly status?: number) {
    super("The Epic connection needs to be reconnected");
    this.name = "ReconnectRequiredError";
  }
}

const FAILURE_CODES = [
  "missing_credentials", "connection_unavailable", "invalid_client_configuration",
  "invalid_client", "invalid_scope", "unauthorized_client", "invalid_request",
  "invalid_token_response", "access_refused", "job_retries_exhausted", "network_error", "upstream_error", "unexpected_error",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number] | ReconnectReason;
export type FailureDiagnostic = { failureStage: EpicStage | "app"; failureCode: FailureCode; httpStatus?: number };

// Only fixed codes and HTTP statuses cross into durable history/logs. Never include
// upstream descriptions, exception messages, URLs, tokens or patient identifiers.
export function failureDiagnostic(error: unknown): FailureDiagnostic {
  if (error instanceof ReconnectRequiredError) {
    return { failureStage: error.reason === "fhir_unauthorized" ? "fhir" : "refresh", failureCode: error.reason, ...(error.status ? { httpStatus: error.status } : {}) };
  }
  if (error instanceof EpicError) {
    const failureCode = FAILURE_CODES.find((code) => code === error.code) ?? "upstream_error";
    const httpStatus = error.status && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined;
    return { failureStage: error.stage, failureCode, ...(httpStatus ? { httpStatus } : {}) };
  }
  return { failureStage: "app", failureCode: "unexpected_error" };
}
