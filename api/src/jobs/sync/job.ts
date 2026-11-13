import { grantsResource } from "@/lib/epic/authorize";
import { ReconnectRequiredError, failureDiagnostic } from "@/lib/epic/errors";
import { SYNC_QUERIES } from "@/lib/sync/plan";
import { failRun, type SyncRequest } from "../../data/sync-runs";
import type { UserScope } from "../../data/scope";
import { NOTES_STATS_KEY, syncNoteTexts } from "./notes";
import { REFERENCES_STATS_KEY, syncReferences } from "./references";
import { beginRun, finishRun, recordStats, syncQuery, type RunStatus, type SyncDeps, type SyncSource } from "./run";

// The sync job (src/lib/sync/job.ts in the Next app): one step to begin, one per query, one for
// referenced resources, one for note text, one to finish. Each step is retried and resumed on its
// own by the Workflow (src/jobs/workflows.ts), so each loads what it needs afresh and returns only
// small, PHI-free values (Workflows store step results).

export type { SyncRequest };

// Recorded for a search the connection has no scope for. Optional, so it's never reported as missing records.
const NOT_GRANTED = { fetched: 0, inserted: 0, superseded: 0, unchanged: 0, removed: 0, optional: true, errorCode: "not_granted" };

// Retries for a step. `prepare` waits on an upstream (Metriport's pull from the networks) by
// failing until it's ready, so it gets more and longer retries.
export type StepOptions = { patient?: boolean };
export type StepRunner = <T extends string | boolean>(id: string, work: () => Promise<T>, options?: StepOptions) => Promise<T>;

export type JobEnv = {
  scope: UserScope;
  now: () => Date;
  // Undefined once the source has no connection (disconnected since the run was queued).
  load: (request: SyncRequest) => Promise<{ deps: SyncDeps; source: SyncSource } | undefined>;
  // Separate from polling so retrying prepare never restarts the upstream query.
  start?: (request: SyncRequest) => Promise<void>;
  // For sources whose records arrive asynchronously: resolves once they're ready, throws to retry.
  prepare?: (request: SyncRequest) => Promise<void>;
};

export async function runSyncJob(request: SyncRequest, step: StepRunner, env: JobEnv, queries = SYNC_QUERIES): Promise<RunStatus> {
  const ready = await step("begin", async () => {
    if (!(await env.load(request))) {
      await failRun(env.scope, request.runId, "error", env.now());
      return false;
    }
    await beginRun(env.scope, request.runId, env.now());
    return true;
  });
  if (!ready) return "failed";

  if (env.start) {
    const { start } = env;
    await step("start retrieval", async () => {
      await start(request);
      return true;
    });
  }

  if (env.prepare) {
    const { prepare } = env;
    await step(
      "prepare",
      async () => {
        await prepare(request);
        return true;
      },
      { patient: true },
    );
  }

  // Loads what the step needs afresh, then does its work. A disconnected source or a refused token
  // ends the run; anything else is thrown for the Workflow to retry.
  const work = (fn: (loaded: { deps: SyncDeps; source: SyncSource }) => Promise<void>) => async (): Promise<"next" | "stop"> => {
    const loaded = await env.load(request);
    if (!loaded) {
      await failRun(env.scope, request.runId, "error", env.now());
      return "stop";
    }
    try {
      await fn(loaded);
      return "next";
    } catch (error) {
      if (!(error instanceof ReconnectRequiredError)) throw error;
      await failRun(env.scope, request.runId, "reconnect", env.now(), failureDiagnostic(error));
      return "stop";
    }
  };

  for (const query of queries) {
    const outcome = await step(
      `query ${query.key}`,
      work(async ({ deps, source }) => {
        // Connected before this search's scope was requested: skip it until the person reconnects.
        if (!grantsResource(source.scope, query.resourceType)) return recordStats(deps.scope, source.runId, query.key, NOT_GRANTED);
        await syncQuery(deps, source, query);
      }),
    );
    if (outcome === "stop") return "failed";
  }

  // After the searches, so references in records imported in this run are included.
  const references = await step("references", work(async ({ deps, source }) => recordStats(deps.scope, source.runId, REFERENCES_STATS_KEY, await syncReferences(deps, source))));
  if (references === "stop") return "failed";

  // After the searches, so notes imported in this run are included.
  const notes = await step(
    "notes",
    work(async ({ deps, source }) => recordStats(deps.scope, source.runId, NOTES_STATS_KEY, grantsResource(source.scope, "Binary") ? await syncNoteTexts(deps, source) : NOT_GRANTED)),
  );
  if (notes === "stop") return "failed";

  return step("finish", () => finishRun(env.scope, request.runId, env.now()));
}
