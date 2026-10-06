import { mintRunnerCapability } from "./capabilities.js";
import type { ChatRepository } from "./contracts.js";

export interface IggyControlPlane {
  startHealthRun(input: { id: string; capability: string }): Promise<void>;
  cancelHealthRun(runId: string): Promise<void>;
  getHealthRunStatus(runId: string): Promise<"queued" | "running" | "completed" | "failed" | "cancelled">;
}

/**
 * Claims only queued work. A run that was ever started is never automatically rerun:
 * the queue-role recovery job marks an expired lease interrupted and retains its audit trail.
 */
export class IggyRunDispatcher {
  private active = 0;
  constructor(private readonly repository: ChatRepository, private readonly iggy: IggyControlPlane, private readonly key: Uint8Array, private readonly issuer: string, private readonly workerId: string, private readonly leaseMs = 30_000) {}

  async dispatchOnce(): Promise<boolean> {
    // One bounded worker per dispatcher process; no overlap from timer ticks.
    if (this.active) return false;
    this.active += 1;
    let run: Awaited<ReturnType<ChatRepository["claimNextRun"]>>;
    try { run = await this.repository.claimNextRun(this.workerId, this.leaseMs); }
    catch (error) { this.active -= 1; throw error; }
    if (!run) { this.active -= 1; return false; }
    try {
      if (await this.repository.isCancellationRequested(run.scope)) {
        await this.repository.finalizeServiceEvent(run.scope, { status: "cancelled" });
        this.active -= 1;
        return true;
      }
      const capability = await mintRunnerCapability(run.scope, this.key, this.issuer, run.attempt, run.leaseOwner);
      await this.iggy.startHealthRun({ id: run.id, capability });
      void this.monitor(run).catch(() => {
        // Stop renewing on a coordinator failure; recovery visibly interrupts the
        // begun run. Never swallow a failure while keeping an orphan lease alive.
      }).finally(() => { this.active -= 1; });
      return true;
    } catch {
      try { await this.repository.finalizeServiceEvent(run.scope, await this.repository.isCancellationRequested(run.scope) ? { status: "cancelled" } : { status: "failed", errorCode: "runner_start_failed" }); }
      finally { this.active -= 1; }
      return true;
    }
  }

  async cancel(runId: string): Promise<void> {
    // Cancellation state is persisted before this best-effort control-plane request.
    await this.iggy.cancelHealthRun(runId);
  }

  private async monitor(run: Awaited<ReturnType<ChatRepository["claimNextRun"]>> & {}): Promise<void> {
    if (!run) return;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(this.leaseMs / 3)));
      if (!(await this.repository.renewLease(run.scope, run.leaseOwner, this.leaseMs))) return;
      if (await this.repository.isCancellationRequested(run.scope)) {
        // Covers cancellation before Iggy had created the run (its earlier
        // control-plane cancel returned 404). State still fences all data access.
        await this.iggy.cancelHealthRun(run.id).catch(() => undefined);
        await this.repository.finalizeServiceEvent(run.scope, { status: "cancelled" });
        return;
      }
      // An unavailable control plane must not get an endlessly renewed lease.
      const status = await this.iggy.getHealthRunStatus(run.id);
      if (status === "running" || status === "queued") continue;
      if (status === "failed" || status === "cancelled") {
        await this.repository.finalizeServiceEvent(run.scope, status === "cancelled" ? { status: "cancelled" } : { status: "failed", errorCode: "runner_failed" });
      }
      // A completed Iggy container must already have sent the fenced broker completion.
      // If it did not, the still-running lease expires into visible `interrupted`, never a retry.
      return;
    }
  }
}
