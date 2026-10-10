import "server-only";
import { randomUUID } from "node:crypto";
import { diagnosticCode } from "./diagnostic-code";

export type ChatRequestContext = { surface: "browser" | "worker"; method: string; path: string[] };

const workerRoutes = new Set(["claims", "execution/context", "execution/cancellation", "execution/tools", "execution/events", "execution/research/begin", "execution/research/result", "control/heartbeat", "control/finalize"]);

/** Only static route labels enter logs; never URLs, query strings or resource IDs. */
function operation(context?: ChatRequestContext): string {
  if (!context) return "unknown";
  const { path, surface } = context;
  if (surface === "worker") return workerRoutes.has(path.join("/")) ? path.join("/") : "unknown";
  if (path.length === 1 && ["conversations", "summaries"].includes(path[0])) return path[0];
  if (path.length === 2 && ["conversations", "summaries", "runs"].includes(path[0])) return `${path[0]}/:id`;
  if (path.length === 3 && path[0] === "conversations" && path[2] === "runs") return "conversations/:id/runs";
  if (path.length === 3 && path[0] === "runs" && ["events", "research-sources"].includes(path[2])) return `runs/:id/${path[2]}`;
  return "unknown";
}

export function chatRequestDiagnostic(context?: ChatRequestContext) {
  const requestId = randomUUID(); // Never trust a caller's correlation header.
  const startedAt = performance.now();
  return {
    requestId,
    failure(status: number, error: unknown) {
      if (status < 500 && status !== 429) return;
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(), level: status >= 500 ? "error" : "warn",
        event: "chat_request_failed", requestId, surface: context?.surface ?? "unknown",
        operation: operation(context), method: context && ["GET", "POST", "DELETE"].includes(context.method) ? context.method : "unknown",
        status, durationMs: Math.round(performance.now() - startedAt), code: diagnosticCode(error),
      });
      if (status >= 500) console.error(entry); else console.warn(entry);
    },
  };
}

export function logChatPoolFailure(pool: "data" | "queue", error: unknown): void {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "chat_database_pool_failed", pool, code: diagnosticCode(error) }));
}

export function logChatRunFailure(code: "runner_start_failed" | "runner_failed" | "worker_timeout" | "coordinator_stopped" | "worker_failed" | "inference_unavailable" | "unspecified", requestId: string): void {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "chat_run_failed", code, requestId }));
}

export function logChatReapedRuns(count: number): void {
  if (count > 0) console.warn(JSON.stringify({ timestamp: new Date().toISOString(), level: "warn", event: "chat_runs_reaped", count }));
}
