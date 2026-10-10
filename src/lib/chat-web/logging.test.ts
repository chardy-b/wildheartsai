import { afterEach, describe, expect, it, vi } from "vitest";
import { chatRequestDiagnostic, logChatPoolFailure, logChatReapedRuns } from "./logging";

afterEach(() => vi.restoreAllMocks());

describe("private chat diagnostics", () => {
  it("logs only allowlisted cause codes and static operation labels", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "patient-message-token-canary";
    const error = Object.assign(new Error(secret, { cause: Object.assign(new Error(secret), { code: "ECONNREFUSED" }) }), { code: secret });
    const diagnostic = chatRequestDiagnostic({ surface: "browser", method: "POST", path: ["conversations", secret, "runs"] });
    diagnostic.failure(503, error);
    const logged = JSON.parse(spy.mock.calls[0][0]);
    expect(logged).toMatchObject({ event: "chat_request_failed", operation: "conversations/:id/runs", method: "POST", status: 503, code: "ECONNREFUSED", requestId: diagnostic.requestId });
    expect(logged.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
  });

  it("omits arbitrary routes, methods, codes, stacks, and circular causes", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "sensitive-canary";
    const error = Object.assign(new Error(secret), { code: secret, cause: {} });
    error.cause = error;
    chatRequestDiagnostic({ surface: "worker", method: secret, path: [secret] }).failure(503, error);
    expect(JSON.parse(spy.mock.calls[0][0])).toMatchObject({ operation: "unknown", method: "unknown", code: "UNKNOWN" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
  });

  it("keeps polling and routine request rejections quiet, warning on throttling", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const status of [200, 400, 401, 403, 404, 409]) chatRequestDiagnostic().failure(status, new Error("private"));
    logChatReapedRuns(0);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    chatRequestDiagnostic().failure(429, new Error("private"));
    logChatReapedRuns(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("reports idle pool errors without driver details", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logChatPoolFailure("queue", Object.assign(new Error("postgres://private"), { code: "28P01" }));
    expect(JSON.parse(spy.mock.calls[0][0])).toMatchObject({ event: "chat_database_pool_failed", pool: "queue", code: "28P01" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("postgres://");
  });
});
