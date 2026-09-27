import type { Db } from "@/lib/db/types";
import { ReconnectRequiredError } from "@/lib/epic/errors";
import { SYNC_QUERIES } from "./plan";
import { NOTES_STATS_KEY, syncNoteTexts } from "./notes";
import { beginRun, failRun, finishRun, recordStats, syncQuery, type RunStatus, type SyncDeps, type SyncSource } from "./run";

// The sync job: one step to begin, one per query, one for note text, one to finish. Each step is retried
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

  // Loads what the step needs afresh, then does its work. A disconnected source or a refused
  // token ends the run; anything else is thrown for the queue to retry.
  const work = (fn: (loaded: { deps: SyncDeps; source: SyncSource }) => Promise<void>) => async (): Promise<"next" | "stop"> => {
    const loaded = await env.load(request);
    if (!loaded) {
      await failRun(env.db, request.runId, "error", env.now());
      return "stop";
    }
    try {
      await fn(loaded);
      return "next";
    } catch (error) {
      if (!(error instanceof ReconnectRequiredError)) throw error;
      await failRun(env.db, request.runId, "reconnect", env.now());
      return "stop";
    }
  };

  for (const query of queries) {
    const outcome = await step(`query ${query.key}`, work(async ({ deps, source }) => void (await syncQuery(deps, source, query))));
    if (outcome === "stop") return "failed";
  }

  // After the searches, so notes imported in this run are included.
  const notes = await step(
    "notes",
    work(async ({ deps, source }) => recordStats(deps.db, source.runId, NOTES_STATS_KEY, await syncNoteTexts(deps, source))),
  );
  if (notes === "stop") return "failed";

  return step("finish", () => finishRun(env.db, request.runId, env.now()));
}
