import "server-only";
import { userKeysFor } from "@/lib/crypto/user-keys";
import { db } from "@/lib/db";
import { getConnectionForSource } from "@/lib/epic/connections";
import { accessTokenFor, tokenKey } from "@/lib/epic/server";
import { fhirSearchBounded } from "@/lib/fhir/client";
import { inngest, syncRequested } from "@/lib/inngest/client";
import { recordsKey } from "@/lib/records-keys";
import { needingFirstSync, type SourceSummary } from "@/lib/sources";
import type { JobEnv, SyncRequest } from "./job";
import { requestSync, type RequestOutcome } from "./request";
import type { SyncTrigger } from "./run";

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

async function send(request: SyncRequest): Promise<void> {
  await inngest.send(syncRequested.create(request));
}

export function requestSyncFor(userId: string, sourceId: string, trigger: SyncTrigger): Promise<RequestOutcome> {
  return requestSync(db, { userId, sourceId, trigger }, send, new Date());
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
