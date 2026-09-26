import "server-only";
import { db } from "@/lib/db";
import { runSyncJob } from "@/lib/sync/job";
import { failRun } from "@/lib/sync/run";
import { queueScheduledRefreshes, sourcesDueForRefresh } from "@/lib/sync/scheduled";
import { loadSyncJob, sendSyncRequest } from "@/lib/sync/server";
import { inngest, syncRequested } from "./client";

// Syncs one source. One run per source at a time; each query is its own retried step.
export const syncSource = inngest.createFunction(
  {
    id: "sync-source",
    triggers: [syncRequested],
    // One run per source; and at most 10 steps at once overall, so the nightly refresh
    // doesn't flood Epic.
    concurrency: [{ key: "event.data.sourceId", limit: 1 }, { limit: 10 }],
    retries: 3,
    // Every retry of a step failed: end the run so the source isn't stuck "importing".
    onFailure: async ({ event }) => {
      const { runId } = event.data.event.data as { runId: string };
      await failRun(db, runId, "error", new Date());
    },
  },
  async ({ event, step }) =>
    // Step results come back JSON-serialised; ours are booleans and strings, which survive unchanged.
    runSyncJob(event.data, (id, work) => step.run(id, work) as Promise<never>, {
      db,
      now: () => new Date(),
      load: loadSyncJob,
    }),
);

const QUEUE_CHUNK = 100;

// Nightly at 10:17 UTC (3:17am Pacific): queue a sync for every connected source not synced in a day.
export const refreshSources = inngest.createFunction(
  { id: "refresh-sources", triggers: [{ cron: "17 10 * * *" }], retries: 2 },
  async ({ step }) => {
    // IDs only: step results are stored by the queue.
    const due = await step.run("find due sources", () => sourcesDueForRefresh(db, new Date()));
    const totals = { due: due.length, queued: 0, skipped: 0, failed: 0 };
    for (let i = 0; i < due.length; i += QUEUE_CHUNK) {
      const counts = await step.run(`queue ${i / QUEUE_CHUNK + 1}`, () =>
        queueScheduledRefreshes(db, due.slice(i, i + QUEUE_CHUNK), sendSyncRequest, new Date()),
      );
      totals.queued += counts.queued;
      totals.skipped += counts.skipped;
      totals.failed += counts.failed;
    }
    return totals;
  },
);


export const functions = [syncSource, refreshSources];
