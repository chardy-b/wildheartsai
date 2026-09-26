import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { epicConnection, fhirResource, healthSource, syncRun, type SyncQueryStats } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

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
};

export async function listSources(db: Db, userId: string): Promise<SourceSummary[]> {
  const [sources, connections, runs, counts] = await Promise.all([
    db.select().from(healthSource).where(eq(healthSource.userId, userId)).orderBy(asc(healthSource.createdAt)),
    db.select({ id: epicConnection.id, sourceId: epicConnection.sourceId }).from(epicConnection).where(eq(epicConnection.userId, userId)),
    db
      .select({ sourceId: syncRun.sourceId, status: syncRun.status, stats: syncRun.stats })
      .from(syncRun)
      .where(eq(syncRun.userId, userId))
      .orderBy(desc(syncRun.queuedAt)),
    db
      .select({ sourceId: fhirResource.sourceId, n: count() })
      .from(fhirResource)
      .where(and(eq(fhirResource.userId, userId), isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt)))
      .groupBy(fhirResource.sourceId),
  ]);

  return sources.map((source) => {
    const mine = runs.filter((r) => r.sourceId === source.id);
    const lastFinished = mine.find((r) => r.status !== "queued" && r.status !== "running");
    return {
      id: source.id,
      organizationName: source.organizationName,
      fhirBaseUrl: source.fhirBaseUrl,
      status: source.status,
      connectionId: connections.find((c) => c.sourceId === source.id)?.id ?? null,
      lastSyncedAt: source.lastSyncedAt,
      lastSyncStatus: source.lastSyncStatus,
      syncing: mine.some((r) => r.status === "queued" || r.status === "running"),
      lastRunStats: lastFinished?.stats ?? null,
      recordCount: counts.find((c) => c.sourceId === source.id)?.n ?? 0,
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

