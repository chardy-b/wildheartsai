import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { FailureDiagnostic } from "@/lib/epic/errors";
import { healthSource, syncRun } from "../db/schema";
import { REFRESH_COOLDOWN_MS, STALE_RUN_MS } from "../sync-constants";
import { auditFrom } from "./audit";
import type { UserScope } from "./scope";

// Queuing a sync of one source (src/lib/sync/request.ts and run.ts in the Next app). The job
// itself runs as a Workflow (Phase 4); this only records the run and hands its ids to the queue.

export type SyncTrigger = "connect" | "manual" | "scheduled";
export type SyncRequest = { runId: string; userId: string; sourceId: string };
export type RequestOutcome = "queued" | "already_running" | "cooldown" | "not_connected";

const ACTIVE: ("queued" | "running")[] = ["queued", "running"];

// Queues a run unless one is already queued or running for the source (then returns that one).
// The partial unique index sync_run_active_idx makes the insert the arbiter.
export async function startRun(scope: UserScope, input: { sourceId: string; trigger: SyncTrigger }, now: Date): Promise<{ runId: string; created: boolean }> {
  await scope.update(
    syncRun,
    { status: "failed", finishedAt: now },
    and(
      eq(syncRun.sourceId, input.sourceId),
      inArray(syncRun.status, ACTIVE),
      lt(sql`coalesce(${syncRun.startedAt}, ${syncRun.queuedAt})`, now.getTime() - STALE_RUN_MS),
    ),
  );
  const [created] = await scope
    .insert(syncRun, { id: crypto.randomUUID(), userId: scope.userId, sourceId: input.sourceId, trigger: input.trigger, status: "queued", queuedAt: now })
    .onConflictDoNothing()
    .returning({ id: syncRun.id });
  if (created) return { runId: created.id, created: true };
  const [active] = await scope.selectFields(syncRun, { id: syncRun.id }, and(eq(syncRun.sourceId, input.sourceId), inArray(syncRun.status, ACTIVE))).limit(1);
  if (!active) throw new Error("Sync run conflict without an active run");
  return { runId: active.id, created: false };
}

// Ends a run that couldn't continue. Audit pattern G: the source update and the audit row are
// guarded on the run still being active, and the run's own update comes last.
export async function failRun(scope: UserScope, runId: string, reason: "reconnect" | "error", now: Date, diagnostic?: FailureDiagnostic): Promise<void> {
  const activeRun = sql`(select ${syncRun.sourceId} from ${syncRun} where ${syncRun.id} = ${runId} and ${syncRun.userId} = ${scope.userId} and ${syncRun.status} in ('queued', 'running'))`;
  await scope.batch([
    scope.update(
      healthSource,
      { lastSyncStatus: "failed", updatedAt: now, ...(reason === "reconnect" ? { status: "reconnect_required" as const } : {}) },
      eq(healthSource.id, activeRun),
    ),
    auditFrom(
      scope,
      syncRun,
      and(eq(syncRun.id, runId), inArray(syncRun.status, ACTIVE))!,
      {
        action: "sync",
        sourceId: syncRun.sourceId,
        detail: sql`json_object('trigger', ${syncRun.trigger}, 'status', 'failed', 'reason', ${reason}${
          diagnostic
            ? sql`, 'failureStage', ${diagnostic.failureStage}, 'failureCode', ${diagnostic.failureCode}${diagnostic.httpStatus ? sql`, 'httpStatus', ${diagnostic.httpStatus}` : sql``}`
            : sql``
        })`,
      },
      now,
    ),
    scope.update(syncRun, { status: "failed", finishedAt: now }, and(eq(syncRun.id, runId), inArray(syncRun.status, ACTIVE))),
  ]);
}

// Queues a sync of one of the person's sources and hands its ids to the job queue.
export async function requestSync(
  scope: UserScope,
  input: { sourceId: string; trigger: SyncTrigger },
  send: (request: SyncRequest) => Promise<void>,
  now: Date,
): Promise<RequestOutcome> {
  const [source] = await scope.selectFields(healthSource, { status: healthSource.status, lastSyncedAt: healthSource.lastSyncedAt }, eq(healthSource.id, input.sourceId)).limit(1);
  if (source?.status !== "connected") return "not_connected";
  if (input.trigger === "manual" && source.lastSyncedAt && now.getTime() - source.lastSyncedAt.getTime() < REFRESH_COOLDOWN_MS) return "cooldown";

  const { runId, created } = await startRun(scope, input, now);
  if (!created) return "already_running";
  try {
    await send({ runId, userId: scope.userId, sourceId: input.sourceId });
  } catch (error) {
    // Otherwise the queued run would block this source until it went stale.
    await failRun(scope, runId, "error", now);
    throw error;
  }
  return "queued";
}
