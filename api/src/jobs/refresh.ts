import { and, asc, eq, gte, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { forUser, system } from "../data/scope";
import { requestSync, type SyncRequest } from "../data/sync-runs";
import type { Db } from "../db";
import { backgroundJobRun, healthSource, syncRun } from "../db/schema";
import { STALE_RUN_MS } from "../sync-constants";

// The nightly background refresh (src/lib/sync/scheduled.ts and schedule-history.ts in the Next
// app): every connected organization not synced in the last day gets a scheduled sync. Sources
// needing a reconnect or disconnected are skipped. Works across people, so it uses the system
// handle to find them and each person's own scope to queue.

// A little under a day, so a source synced at 3:20am yesterday is due at 3:17am today.
export const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;
// Upper bound per nightly run; anything beyond waits for the next night, oldest first.
export const SCHEDULED_BATCH = 2000;

export type DueSource = { userId: string; sourceId: string };
export type ScheduleTotals = { due: number; queued: number; skipped: number; failed: number };

export async function sourcesDueForRefresh(db: Db, now: Date, limit = SCHEDULED_BATCH): Promise<DueSource[]> {
  // A run older than STALE_RUN_MS was lost; it doesn't block, and startRun fails it when this queues.
  const active = system(db)
    .select({ one: sql`1` })
    .from(syncRun)
    .where(and(eq(syncRun.sourceId, healthSource.id), sql`${syncRun.status} in ('queued', 'running')`, gte(sql`coalesce(${syncRun.startedAt}, ${syncRun.queuedAt})`, now.getTime() - STALE_RUN_MS)));
  return system(db)
    .select({ userId: healthSource.userId, sourceId: healthSource.id })
    .from(healthSource)
    .where(and(eq(healthSource.status, "connected"), or(isNull(healthSource.lastSyncedAt), lt(healthSource.lastSyncedAt, new Date(now.getTime() - REFRESH_AFTER_MS))), notExists(active)))
    // SQLite sorts nulls first ascending: never-synced sources first, as in Postgres.
    .orderBy(asc(healthSource.lastSyncedAt), asc(healthSource.id))
    .limit(limit);
}

// Queues a scheduled sync for each source, in its owner's scope. One failure doesn't stop the rest.
export async function queueScheduledRefreshes(db: Db, due: DueSource[], send: (request: SyncRequest) => Promise<void>, now: Date): Promise<Omit<ScheduleTotals, "due">> {
  const counts = { queued: 0, skipped: 0, failed: 0 };
  for (const { userId, sourceId } of due) {
    try {
      const outcome = await requestSync(forUser(db, userId), { sourceId, trigger: "scheduled" }, send, now);
      if (outcome === "queued") counts.queued++;
      else counts.skipped++;
    } catch (error) {
      counts.failed++;
      console.error("[sync] scheduled queueing failed", error instanceof Error ? error.name : "unknown");
    }
  }
  return counts;
}

// Operational history: no user or source ids, record counts or errors.
export async function beginSchedule(db: Db, id: string, now: Date): Promise<void> {
  await system(db).insert(backgroundJobRun).values({ id, job: "refresh_sources", status: "running", startedAt: now }).onConflictDoNothing();
}

export async function finishSchedule(db: Db, id: string, totals: ScheduleTotals, now: Date): Promise<void> {
  await system(db).update(backgroundJobRun).set({ ...totals, status: totals.failed ? "partial" : "ok", finishedAt: now }).where(eq(backgroundJobRun.id, id));
}

export async function failSchedule(db: Db, id: string, now: Date): Promise<void> {
  await system(db).update(backgroundJobRun).set({ status: "failed", finishedAt: now }).where(eq(backgroundJobRun.id, id));
}
