import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { forUser } from "../data/scope";
import { failRun, type SyncRequest } from "../data/sync-runs";
import { database } from "../db";
import type { Bindings } from "../env";
import { sendTo } from "../sync-queue";
import { activate, cleanUp, downloadDirectory, ROWS_PER_STEP, writeSlice } from "./directory/import";
import { beginSchedule, failSchedule, finishSchedule, queueScheduledRefreshes, sourcesDueForRefresh, type ScheduleTotals } from "./refresh";
import { runSyncJob } from "./sync/job";
import { syncJobEnv } from "./sync/load";

// The background jobs, as Cloudflare Workflows (they replace the Inngest functions in
// src/lib/inngest/functions.ts in the Next app). Each step is retried on its own and its result
// stored, so step results stay small and hold ids and counts only.

// As Inngest's `retries: 3` for a sync step.
const SYNC_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" };
// Waiting on an upstream that's still working (Metriport's pull): more, longer retries.
const PATIENT_STEP: WorkflowStepConfig = { retries: { limit: 10, delay: "30 seconds", backoff: "linear" }, timeout: "2 minutes" };
const JOB_STEP: WorkflowStepConfig = { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" };

// Syncs one source. One instance per run (instance id = run id); the active-run index keeps one
// run per source at a time.
export class SyncSourceWorkflow extends WorkflowEntrypoint<Bindings, SyncRequest> {
  async run(event: WorkflowEvent<SyncRequest>, step: WorkflowStep) {
    const request = event.payload;
    const scope = forUser(database(this.env.DB), request.userId);
    try {
      return await runSyncJob(request, (id, work, options) => step.do(id, options?.patient ? PATIENT_STEP : SYNC_STEP, work), syncJobEnv(this.env, scope));
    } catch (error) {
      // Every retry of a step failed: end the run so the source isn't stuck "importing".
      await step.do("end failed run", JOB_STEP, async () => {
        await failRun(scope, request.runId, "error", new Date(), { failureStage: "app", failureCode: "job_retries_exhausted" });
        return true;
      });
      throw error;
    }
  }
}

// Nightly at 10:17 UTC (cron in wrangler.jsonc): queues a sync for every connected source not
// synced in a day. Inngest capped syncs at 5 at once so Epic wasn't flooded; Workflows have no
// such cap, so this queues in small groups, a minute apart.
export const PACE_GROUP = 25;

export class RefreshSourcesWorkflow extends WorkflowEntrypoint<Bindings> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const db = database(this.env.DB);
    const id = event.instanceId;
    try {
      await step.do("record schedule start", JOB_STEP, async () => {
        await beginSchedule(db, id, new Date());
        return true;
      });
      // Ids only: step results are stored by Workflows.
      const due = await step.do("find due sources", JOB_STEP, () => sourcesDueForRefresh(db, new Date()));
      const totals: ScheduleTotals = { due: due.length, queued: 0, skipped: 0, failed: 0 };
      for (let i = 0; i < due.length; i += PACE_GROUP) {
        const group = i / PACE_GROUP + 1;
        if (i > 0) await step.sleep(`pace ${group}`, "1 minute");
        const counts = await step.do(`queue ${group}`, JOB_STEP, () => queueScheduledRefreshes(db, due.slice(i, i + PACE_GROUP), sendTo(this.env), new Date()));
        totals.queued += counts.queued;
        totals.skipped += counts.skipped;
        totals.failed += counts.failed;
      }
      await step.do("record schedule result", JOB_STEP, async () => {
        await finishSchedule(db, id, totals, new Date());
        return true;
      });
      console.info("[sync] nightly schedule finished", totals);
      return totals;
    } catch (error) {
      await step.do("record schedule failure", JOB_STEP, async () => {
        await failSchedule(db, id, new Date());
        return true;
      });
      throw error;
    }
  }
}

// Daily at 08:41 UTC, or on request (`wrangler workflows trigger`): replaces the stored directory
// of Epic health systems and their clinics. A failure before "activate" keeps yesterday's.
export class DirectoryImportWorkflow extends WorkflowEntrypoint<Bindings> {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const db = database(this.env.DB);
    const download = await step.do("download and merge", JOB_STEP, () => downloadDirectory(db, this.env.FILES));
    if (!download.changed) return download;
    for (let slice = 0; slice * ROWS_PER_STEP < download.total; slice++) {
      await step.do(`write ${slice + 1}`, JOB_STEP, () => writeSlice(db, this.env.FILES, download.generation, slice));
    }
    await step.do("activate", JOB_STEP, async () => {
      await activate(db, download, new Date());
      return true;
    });
    await step.do("clean up", JOB_STEP, async () => {
      await cleanUp(db, this.env.FILES);
      return true;
    });
    return { changed: true, organizations: download.organizations, facilities: download.facilities, addresses: download.addresses };
  }
}
