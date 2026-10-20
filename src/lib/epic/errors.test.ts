import { describe, expect, it } from "vitest";
import { EpicError, ReconnectRequiredError, failureDiagnostic } from "./errors";

describe("private connection failure diagnostics", () => {
  it("distinguishes missing refresh access from rejected refresh access", () => {
    expect(failureDiagnostic(new ReconnectRequiredError("missing_refresh_token"))).toEqual({ failureStage: "refresh", failureCode: "missing_refresh_token" });
    expect(failureDiagnostic(new ReconnectRequiredError("refresh_rejected", 400))).toEqual({ failureStage: "refresh", failureCode: "refresh_rejected", httpStatus: 400 });
  });

  it("keeps configuration and upstream errors separate without copying arbitrary text", () => {
    expect(failureDiagnostic(new EpicError("refresh", undefined, "missing_credentials"))).toEqual({ failureStage: "refresh", failureCode: "missing_credentials" });
    expect(failureDiagnostic(new EpicError("refresh", 503, "secret-token patient-123"))).toEqual({ failureStage: "refresh", failureCode: "upstream_error", httpStatus: 503 });
    expect(failureDiagnostic(new Error("secret-token patient-123"))).toEqual({ failureStage: "app", failureCode: "unexpected_error" });
  });
});
