export type ModelWarmupStatus = "idle" | "queued" | "running" | "ready" | "failed";
export type ModelWarmupSnapshot = { status: ModelWarmupStatus; retryAt: string | null; readyUntil: string | null };
export type ModelWarmupOutcome = "settled" | "stale" | "timed-out";

// Covers the 90s queue allowance, 150s worker lease, and 15s of transition margin.
export const MODEL_WARMUP_MAX_WAIT_MS = 255_000;
export const MODEL_WARMUP_POLL_MS = 2_000;
export const MODEL_WARMUP_REQUEST_TIMEOUT_MS = 10_000;

export function parseModelWarmupSnapshot(value: unknown): ModelWarmupSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_warmup_response");
  const candidate = value as { status?: unknown; retryAt?: unknown; readyUntil?: unknown };
  const statuses: ModelWarmupStatus[] = ["idle", "queued", "running", "ready", "failed"];
  if (!statuses.includes(candidate.status as ModelWarmupStatus)) throw new Error("invalid_warmup_response");
  const retryAt = candidate.retryAt ?? null;
  if (retryAt !== null && (typeof retryAt !== "string" || !Number.isFinite(Date.parse(retryAt)))) throw new Error("invalid_warmup_response");
  const readyUntil = candidate.readyUntil ?? null;
  if (readyUntil !== null && (typeof readyUntil !== "string" || !Number.isFinite(Date.parse(readyUntil)))) throw new Error("invalid_warmup_response");
  if (candidate.status === "ready" && readyUntil === null) throw new Error("invalid_warmup_response");
  return { status: candidate.status as ModelWarmupStatus, retryAt: retryAt as string | null, readyUntil: readyUntil as string | null };
}

export async function monitorModelWarmup(options: {
  post: (signal: AbortSignal, timeoutMs: number) => Promise<ModelWarmupSnapshot>;
  get: (signal: AbortSignal, timeoutMs: number) => Promise<ModelWarmupSnapshot>;
  onStatus: (snapshot: ModelWarmupSnapshot) => void;
  signal: AbortSignal;
  isCurrent: () => boolean;
  wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  maxWaitMs?: number;
  pollMs?: number;
}): Promise<ModelWarmupOutcome> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.maxWaitMs ?? MODEL_WARMUP_MAX_WAIT_MS);
  const isCurrent = () => !options.signal.aborted && options.isCurrent();
  const remaining = () => deadline - now();
  const requestTimeout = () => Math.max(1, Math.min(MODEL_WARMUP_REQUEST_TIMEOUT_MS, remaining()));

  if (!isCurrent()) return "stale";
  let snapshot = await options.post(options.signal, requestTimeout());
  if (!isCurrent()) return "stale";
  options.onStatus(snapshot);

  while (snapshot.status === "queued" || snapshot.status === "running") {
    const timeLeft = remaining();
    if (timeLeft <= 0) return "timed-out";
    await options.wait(Math.min(options.pollMs ?? MODEL_WARMUP_POLL_MS, timeLeft), options.signal);
    if (!isCurrent()) return "stale";
    if (remaining() <= 0) return "timed-out";
    snapshot = await options.get(options.signal, requestTimeout());
    if (!isCurrent()) return "stale";
    options.onStatus(snapshot);
  }
  return "settled";
}
