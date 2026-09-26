import { and, asc, count, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { epicConnection, fhirResource, healthSource, syncRun, type SyncQueryStats } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { STALE_RUN_MS } from "@/lib/sync/run";

// The organizations a person has connected, as the connections page and dashboard see
// them: status, sync state and how many records are stored. No secrets, no PHI.

export type SourceSummary = {
  id: string;
  organizationName: string;
  fhirBaseUrl: string;
  status: "connected" | "reconnect_required" | "disconnected";
  // The tokens row, when the source is still connected (needed to disconnect, and to load a note).
  connectionId: string | null;
  lastSyncedAt: Date | null;
  lastSyncStatus: "ok" | "partial" | "failed" | null;
  syncing: boolean;
  // Per-query stats of the last finished run, for saying what didn't load.
  lastRunStats: Record<string, SyncQueryStats> | null;
  recordCount: number;
  // Stored, visible records per category (RecordCategory keys).
  categoryCounts: Partial<Record<string, number>>;
};

const ACTIVE: ("queued" | "running")[] = ["queued", "running"];

export async function listSources(db: Db, userId: string, now = new Date()): Promise<SourceSummary[]> {
  const [sources, connections, active, lastFinished, counts] = await Promise.all([
    db.select().from(healthSource).where(eq(healthSource.userId, userId)).orderBy(asc(healthSource.createdAt)),
    db.select({ id: epicConnection.id, sourceId: epicConnection.sourceId }).from(epicConnection).where(eq(epicConnection.userId, userId)),
    // A run queued or started longer ago than STALE_RUN_MS was lost (startRun fails it on the
    // next request), so it doesn't count as importing.
    db
      .select({ sourceId: syncRun.sourceId })
      .from(syncRun)
      .where(
        and(
          eq(syncRun.userId, userId),
          inArray(syncRun.status, ACTIVE),
          gte(sql`coalesce(${syncRun.startedAt}, ${syncRun.queuedAt})`, new Date(now.getTime() - STALE_RUN_MS)),
        ),
      ),
    // Only the latest finished run per source, rather than the whole history.
    db
      .selectDistinctOn([syncRun.sourceId], { sourceId: syncRun.sourceId, stats: syncRun.stats })
      .from(syncRun)
      .where(and(eq(syncRun.userId, userId), notInArray(syncRun.status, ACTIVE)))
      .orderBy(syncRun.sourceId, desc(syncRun.queuedAt)),
    db
      .select({ sourceId: fhirResource.sourceId, category: fhirResource.category, n: count() })
      .from(fhirResource)
      .where(and(eq(fhirResource.userId, userId), isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt)))
      .groupBy(fhirResource.sourceId, fhirResource.category),
  ]);

  return sources.map((source) => {
    const categoryCounts: Partial<Record<string, number>> = {};
    for (const c of counts) if (c.sourceId === source.id && c.category) categoryCounts[c.category] = c.n;
    return {
      id: source.id,
      organizationName: source.organizationName,
      fhirBaseUrl: source.fhirBaseUrl,
      status: source.status,
      connectionId: connections.find((c) => c.sourceId === source.id)?.id ?? null,
      lastSyncedAt: source.lastSyncedAt,
      lastSyncStatus: source.lastSyncStatus,
      syncing: active.some((r) => r.sourceId === source.id),
      lastRunStats: lastFinished.find((r) => r.sourceId === source.id)?.stats ?? null,
      recordCount: counts.filter((c) => c.sourceId === source.id).reduce((sum, c) => sum + c.n, 0),
      categoryCounts,
    };
  });
}

// Deletes the organization with its tokens, stored records and sync history.
export async function deleteSource(db: Db, userId: string, sourceId: string): Promise<boolean> {
  const deleted = await db
    .delete(healthSource)
    .where(and(eq(healthSource.id, sourceId), eq(healthSource.userId, userId)))
    .returning({ id: healthSource.id });
  return deleted.length > 0;
}

// Connected sources that have never finished a sync and have none in progress: the
// sources that existed before records were stored, or whose first sync never got queued.
export function needingFirstSync(sources: SourceSummary[]): SourceSummary[] {
  return sources.filter((s) => s.status === "connected" && !s.lastSyncedAt && !s.syncing && !s.lastSyncStatus);
}

