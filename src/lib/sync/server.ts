import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { userKeysFor } from "@/lib/crypto/user-keys";
import { db } from "@/lib/db";
import { getConnectionForSource } from "@/lib/epic/connections";
import { accessTokenFor, tokenKey } from "@/lib/epic/server";
import { fhirSearchBounded } from "@/lib/fhir/client";
import { recordsKey } from "@/lib/records-keys";
import { needingFirstSync, type SourceSummary } from "@/lib/sources";
import { runSyncJob, type JobEnv, type StepRunner, type SyncRequest } from "./job";
import { requestSync, type RequestOutcome } from "./request";
import { failRun, type SyncTrigger } from "./run";

// Everything one sync step needs, loaded fresh for each step. Secrets stay in memory.
export const loadSyncJob: JobEnv["load"] = async ({ runId, userId, sourceId }) => {
  const connection = await getConnectionForSource(db, tokenKey(), userId, sourceId);
  if (!connection) return undefined;
  const keys = await userKeysFor(db, recordsKey(), userId, new Date());
  return {
    source: {
      runId,
      userId,
      sourceId,
      organizationName: connection.organizationName,
      fhirBaseUrl: connection.fhirBaseUrl,
      patientId: connection.patientId,
    },
    deps: {
      db,
      keys,
      now: () => new Date(),
      accessToken: () => accessTokenFor(connection),
      search: (input) => fhirSearchBounded(input),
    },
  };
};

// Hands a sync to Cloudflare Workflows (SyncWorkflow in src/worker/sync-workflow.ts).
// The instance ID is the run ID, so a run starts at most once. The payload carries IDs
// only: Workflows stores it, and every step loads what it needs from D1.
async function startSyncWorkflow(request: SyncRequest): Promise<void> {
  const { env, ctx } = getCloudflareContext();
  if (env.SYNC_WORKFLOW) {
    await env.SYNC_WORKFLOW.create({ id: request.runId, params: request });
    return;
  }
  // `next dev` has no Workflows runtime: run the job here, after the response is sent.
  if (process.env.NODE_ENV === "production") throw new Error("SYNC_WORKFLOW binding is missing");
  ctx.waitUntil(runInDevelopment(request));
}

async function runInDevelopment(request: SyncRequest): Promise<void> {
  const step: StepRunner = (_id, work) => work();
  try {
    await runSyncJob(request, step, { db, now: () => new Date(), load: loadSyncJob });
  } catch (error) {
    console.error("[sync] local run failed", error instanceof Error ? error.name : "unknown");
    await failRun(db, request.runId, "error", new Date());
  }
}

export function requestSyncFor(userId: string, sourceId: string, trigger: SyncTrigger): Promise<RequestOutcome> {
  return requestSync(db, { userId, sourceId, trigger }, startSyncWorkflow, new Date());
}

// Queues a first sync for connected sources that never had one (for example, those
// connected before records were stored). Returns whether any were queued.
export async function startFirstSyncs(userId: string, sources: SourceSummary[]): Promise<boolean> {
  const pending = needingFirstSync(sources);
  const outcomes = await Promise.all(
    pending.map((s) =>
      requestSyncFor(userId, s.id, "connect").catch((error: unknown) => {
        console.error("[sync] queueing failed", error instanceof Error ? error.name : "unknown");
        return "not_connected" as const;
      }),
    ),
  );
  return outcomes.includes("queued");
}
