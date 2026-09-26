import { and, asc, eq, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { healthSource, syncRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { SyncRequest } from "./job";
import { requestSync } from "./request";

// The nightly background refresh: every connected organization not synced in the last
// day gets a scheduled sync. Sources needing a reconnect or disconnected are skipped;
// they can't sync until the person signs in again.

// A little under a day, so a source synced at 3:20am yesterday is due at 3:17am today.
export const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;
// Upper bound per nightly run; anything beyond waits for the next night, oldest first.
export const SCHEDULED_BATCH = 2000;

export type DueSource = { userId: string; sourceId: string };

export async function sourcesDueForRefresh(db: Db, now: Date, limit = SCHEDULED_BATCH): Promise<DueSource[]> {
  const active = db
    .select({ one: sql`1` })
    .from(syncRun)
    .where(and(eq(syncRun.sourceId, healthSource.id), sql`${syncRun.status} in ('queued', 'running')`));
  return db
    .select({ userId: healthSource.userId, sourceId: healthSource.id })
    .from(healthSource)
    .where(
      and(
        eq(healthSource.status, "connected"),
        or(isNull(healthSource.lastSyncedAt), lt(healthSource.lastSyncedAt, new Date(now.getTime() - REFRESH_AFTER_MS))),
        notExists(active),
      ),
    )
    .orderBy(sql`${healthSource.lastSyncedAt} asc nulls first`, asc(healthSource.id))
    .limit(limit);
}

// Queues a scheduled sync for each source. One failure doesn't stop the rest.
export async function queueScheduledRefreshes(
  db: Db,
  due: DueSource[],
  send: (request: SyncRequest) => Promise<void>,
  now: Date,
): Promise<{ queued: number; skipped: number; failed: number }> {
  const counts = { queued: 0, skipped: 0, failed: 0 };
  for (const { userId, sourceId } of due) {
    try {
      const outcome = await requestSync(db, { userId, sourceId, trigger: "scheduled" }, send, now);
      if (outcome === "queued") counts.queued++;
      else counts.skipped++;
    } catch (error) {
      counts.failed++;
      console.error("[sync] scheduled queueing failed", error instanceof Error ? error.name : "unknown");
    }
  }
  return counts;
}
