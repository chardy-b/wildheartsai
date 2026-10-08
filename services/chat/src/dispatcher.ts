import { randomUUID } from "node:crypto";
import type { FinalizeInput } from "./protocol.js";
import type { ClaimedWebRun } from "./contracts.js";

export interface IggyControlPlane {
  startHealthRun(input: { id: string; capability: string }): Promise<void>;
  cancelHealthRun(runId: string): Promise<void>;
  getHealthRunStatus(runId: string): Promise<"queued" | "running" | "completed" | "failed" | "cancelled">;
}

export interface ChatCoordinatorApi {
  claim(input: { requestId: string; workerId: string }): Promise<{ run: ClaimedWebRun | null }>;
  heartbeat(controlGrant: string): Promise<{ active: boolean; cancelled: boolean; deadlineAt: string }>;
  finalize(controlGrant: string, input: FinalizeInput): Promise<{ status: "accepted" | "duplicate" }>;
}

export type DispatcherOptions = Readonly<{
  monitorPollMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

/** Owns one remote lease at a time. The execution grant is sent only to Iggy. */
export class IggyRunDispatcher {
  private active = false;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly api: ChatCoordinatorApi, private readonly iggy: IggyControlPlane, private readonly workerId: string, options: DispatcherOptions = {}) {
    this.pollMs = Math.max(100, options.monitorPollMs ?? 5_000);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async dispatchOnce(): Promise<boolean> {
    if (this.active) return false;
    this.active = true;
    const requestId = randomUUID();
    let run: ClaimedWebRun | null;
    try {
      // ChatWebApi retries this POST with the same requestId and serialized body.
      ({ run } = await this.api.claim({ requestId, workerId: this.workerId }));
    } catch (error) {
      this.active = false;
      throw error;
    }
    if (!run) {
      this.active = false;
      return false;
    }
    try {
      // The control grant stays in this process. Only the execution grant crosses
      // into the isolated Iggy run environment.
      await this.iggy.startHealthRun({ id: run.id, capability: run.executionGrant });
    } catch {
      try {
        // A timed-out start call may have reached Iggy despite its lost reply.
        // Stop that idempotent run before finalizing the web-owned lease.
        await this.iggy.cancelHealthRun(run.id).catch(() => undefined);
        await this.api.finalize(run.controlGrant, { requestId, status: "failed", errorCode: "runner_start_failed" });
      }
      finally { this.active = false; }
      return true;
    }
    try {
      await this.monitor(run, requestId);
      return true;
    } finally {
      this.active = false;
    }
  }

  private async monitor(run: ClaimedWebRun, requestId: string): Promise<void> {
    while (true) {
      await this.sleep(this.pollMs);
      const heartbeat = await this.api.heartbeat(run.controlGrant);
      if (heartbeat.cancelled) {
        await this.iggy.cancelHealthRun(run.id).catch(() => undefined);
        await this.api.finalize(run.controlGrant, { requestId, status: "cancelled" });
        return;
      }
      if (!heartbeat.active) return;
      if (Date.now() >= Date.parse(heartbeat.deadlineAt)) {
        await this.iggy.cancelHealthRun(run.id).catch(() => undefined);
        await this.api.finalize(run.controlGrant, { requestId, status: "failed", errorCode: "worker_timeout" });
        return;
      }
      const status = await this.iggy.getHealthRunStatus(run.id);
      if (status === "queued" || status === "running") continue;
      if (status === "cancelled") await this.api.finalize(run.controlGrant, { requestId, status: "cancelled" });
      else if (status === "failed") await this.api.finalize(run.controlGrant, { requestId, status: "failed", errorCode: "runner_failed" });
      else if (status === "completed") await this.api.finalize(run.controlGrant, { requestId, status: "interrupted", errorCode: "coordinator_stopped" });
      return;
    }
  }
}

export type DispatchLoopOptions = Readonly<{ minIdleMs?: number; maxIdleMs?: number; random?: () => number; sleep?: (ms: number) => Promise<void> }>;

/** Claims at a rate that stays below the web API's six-claims-per-minute limit. */
export async function runDispatchLoop(dispatcher: Pick<IggyRunDispatcher, "dispatchOnce">, signal: AbortSignal, options: DispatchLoopOptions = {}): Promise<void> {
  const minimum = Math.min(30_000, Math.max(10_000, options.minIdleMs ?? 10_000));
  const maximum = Math.max(minimum, Math.min(30_000, options.maxIdleMs ?? 30_000));
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let idleRounds = 0;
  while (!signal.aborted) {
    let claimed = false;
    let retryAfterMs = 0;
    try { claimed = await dispatcher.dispatchOnce(); }
    catch (error) {
      claimed = false;
      const hinted = (error as { retryAfterMs?: unknown }).retryAfterMs;
      if (typeof hinted === "number" && Number.isFinite(hinted)) retryAfterMs = Math.max(0, Math.min(30_000, hinted));
    }
    if (claimed) idleRounds = 0;
    else idleRounds += 1;
    if (signal.aborted) return;
    const ceiling = Math.min(maximum, minimum * (2 ** Math.min(16, idleRounds)));
    const jitter = Math.max(0, Math.min(0.999_999, random()));
    await sleep(Math.max(minimum + Math.floor((ceiling - minimum) * jitter), retryAfterMs));
  }
}
