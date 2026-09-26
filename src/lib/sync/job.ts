import type { Db } from "@/lib/db/types";
import { ReconnectRequiredError } from "@/lib/epic/errors";
import { SYNC_QUERIES } from "./plan";
import { beginRun, failRun, finishRun, syncQuery, type RunStatus, type SyncDeps, type SyncSource } from "./run";

// The sync job: one step to begin, one per query, one to finish. Each step is retried
// and resumed on its own by the queue, so each loads what it needs afresh and returns
// only small, PHI-free values (the queue stores step results).

// What the queue event carries: IDs only.
export type SyncRequest = { runId: string; userId: string; sourceId: string };

export type StepRunner = <T>(id: string, work: () => Promise<T>) => Promise<T>;

export type JobEnv = {
  db: Db;
  now: () => Date;
  // Undefined once the source has no connection (disconnected since the run was queued).
  load: (request: SyncRequest) => Promise<{ deps: SyncDeps; source: SyncSource } | undefined>;
};

export async function runSyncJob(request: SyncRequest, step: StepRunner, env: JobEnv, queries = SYNC_QUERIES): Promise<RunStatus> {
  const ready = await step("begin", async () => {
    if (!(await env.load(request))) {
      await failRun(env.db, request.runId, "error", env.now());
      return false;
    }
    await beginRun(env.db, request.runId, env.now());
    return true;
  });
  if (!ready) return "failed";

  for (const query of queries) {
    const outcome = await step(`query ${query.key}`, async () => {
      const loaded = await env.load(request);
      if (!loaded) {
        await failRun(env.db, request.runId, "error", env.now());
        return "stop";
      }
      try {
        await syncQuery(loaded.deps, loaded.source, query);
        return "next";
      } catch (error) {
        if (!(error instanceof ReconnectRequiredError)) throw error; // retried by the queue
        await failRun(env.db, request.runId, "reconnect", env.now());
        return "stop";
      }
    });
    if (outcome === "stop") return "failed";
  }

  return step("finish", () => finishRun(env.db, request.runId, env.now()));
}
