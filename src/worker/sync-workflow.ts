import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { db } from "@/lib/db";
import { runSyncJob, type SyncRequest } from "@/lib/sync/job";
import { failRun } from "@/lib/sync/run";
import { loadSyncJob } from "@/lib/sync/server";
import { withAppContext } from "./context";

// Every step is retried on its own; Workflows keeps each finished step's result, so a
// retried or resumed run picks up where it stopped. Step results are small and PHI-free.
const STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

// Syncs one source. The instance ID is the run ID; at most one run per source is active
// (sync_run_active_idx), so runs of the same source never overlap.
export class SyncWorkflow extends WorkflowEntrypoint<CloudflareEnv, SyncRequest> {
  async run(event: Readonly<WorkflowEvent<SyncRequest>>, step: WorkflowStep) {
    // Workflows calls each step's callback outside run()'s async context, so every step
    // sets up the app context (bindings, process.env) itself.
    const inStep = <T>(id: string, work: () => Promise<T>) =>
      step.do(id, STEP, (() => withAppContext(this.env, this.ctx, work)) as never) as Promise<T>;
    try {
      return await runSyncJob(event.payload, inStep, { db, now: () => new Date(), load: loadSyncJob });
    } catch (error) {
      // Every retry of a step failed: end the run so the source isn't stuck "importing".
      await inStep("fail", () => failRun(db, event.payload.runId, "error", new Date()));
      throw error;
    }
  }
}
