import "server-only";
import { userKeysFor } from "@/lib/crypto/user-keys";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { healthSource } from "@/lib/db/schema";
import { getConnectionForSource } from "@/lib/epic/connections";
import { accessTokenFor, tokenKey } from "@/lib/epic/server";
import { fhirRead, fhirSearchBounded } from "@/lib/fhir/client";
import { inngest, syncRequested } from "@/lib/inngest/client";
import { loadMetriportSyncJob, prepareMetriportSource } from "@/lib/metriport/server";
import { recordsKey } from "@/lib/records-keys";
import { needingFirstSync, type SourceSummary } from "@/lib/sources";
import type { JobEnv, SyncRequest } from "./job";
import { requestSync, type RequestOutcome } from "./request";
import type { SyncTrigger } from "./run";

// Everything one sync step needs, loaded fresh for each step. Secrets stay in memory.
export const loadSyncJob: JobEnv["load"] = async (request) => {
  const { runId, userId, sourceId } = request;
  if ((await vendorOf(userId, sourceId)) === "metriport") return loadMetriportSyncJob(request);
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
      scope: connection.scope,
    },
    deps: {
      db,
      keys,
      now: () => new Date(),
      accessToken: () => accessTokenFor(connection),
      search: (input) => fhirSearchBounded(input),
      read: (input) => fhirRead(input),
    },
  };
};

async function vendorOf(userId: string, sourceId: string): Promise<"epic" | "metriport" | undefined> {
  const [row] = await db
    .select({ vendor: healthSource.vendor })
    .from(healthSource)
    .where(and(eq(healthSource.id, sourceId), eq(healthSource.userId, userId)))
    .limit(1);
  return row?.vendor;
}

// Metriport sources wait for the pull from the networks before the searches run.
export const prepareSyncJob: NonNullable<JobEnv["prepare"]> = async ({ userId, sourceId }) => {
  if ((await vendorOf(userId, sourceId)) === "metriport") await prepareMetriportSource(userId, sourceId);
};

export async function sendSyncRequest(request: SyncRequest): Promise<void> {
  await inngest.send(syncRequested.create(request));
}

export function requestSyncFor(userId: string, sourceId: string, trigger: SyncTrigger): Promise<RequestOutcome> {
  return requestSync(db, { userId, sourceId, trigger }, sendSyncRequest, new Date());
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
