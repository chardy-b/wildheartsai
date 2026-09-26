import "server-only";
import { db } from "@/lib/db";
import { runSyncJob } from "@/lib/sync/job";
import { failRun } from "@/lib/sync/run";
import { loadSyncJob } from "@/lib/sync/server";
import { inngest, syncRequested } from "./client";

// Syncs one source. One run per source at a time; each query is its own retried step.
export const syncSource = inngest.createFunction(
  {
    id: "sync-source",
    triggers: [syncRequested],
    concurrency: { key: "event.data.sourceId", limit: 1 },
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

export const functions = [syncSource];
