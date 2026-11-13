import { and, asc, count, eq, gte, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { SourceSummary } from "@/lib/sources";
import { STALE_RUN_MS } from "../sync-constants";
import { epicConnection, fhirResource, healthSource, metriportConnection, syncRun } from "../db/schema";
import { auditFrom } from "./audit";
import type { UserScope } from "./scope";

// The organizations a person has connected, as the connections page and dashboard see them
// (src/lib/sources.ts in the Next app): status, sync state and record counts. No secrets, no PHI.

export type { SourceSummary };

const ACTIVE: ("queued" | "running")[] = ["queued", "running"];

export async function listSources(scope: UserScope, now = new Date()): Promise<SourceSummary[]> {
  const [sources, epicConnections, metriportConnections, active, lastFinished, counts] = await Promise.all([
    scope.select(healthSource).orderBy(asc(healthSource.createdAt)),
    scope.selectFields(epicConnection, { id: epicConnection.id, sourceId: epicConnection.sourceId, scope: epicConnection.scope }),
    scope.selectFields(metriportConnection, { id: metriportConnection.id, sourceId: metriportConnection.sourceId }),
    // A run queued or started longer ago than STALE_RUN_MS was lost, so it doesn't count as importing.
    scope.selectFields(
      syncRun,
      { sourceId: syncRun.sourceId },
      and(inArray(syncRun.status, ACTIVE), gte(sql`coalesce(${syncRun.startedAt}, ${syncRun.queuedAt})`, now.getTime() - STALE_RUN_MS)),
    ),
    // Only the latest finished run per source (Postgres used DISTINCT ON).
    scope.selectFields(
      syncRun,
      { sourceId: syncRun.sourceId, stats: syncRun.stats },
      and(
        notInArray(syncRun.status, ACTIVE),
        eq(syncRun.queuedAt, sql`(select max(r.queued_at) from ${syncRun} r where r.source_id = ${syncRun.sourceId} and r.status not in ('queued', 'running'))`),
      ),
    ),
    scope
      .selectFields(
        fhirResource,
        { sourceId: fhirResource.sourceId, category: fhirResource.category, n: count() },
        and(isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt), isNotNull(fhirResource.category)),
      )
      .groupBy(fhirResource.sourceId, fhirResource.category),
  ]);

  // Metriport links hold no per-resource permissions, so they have an id (to disconnect) but no scope.
  const connections = [...epicConnections, ...metriportConnections.map((c) => ({ ...c, scope: null as string | null }))];
  return sources.map((source) => {
    const categoryCounts: Partial<Record<string, number>> = {};
    for (const c of counts) if (c.sourceId === source.id && c.category) categoryCounts[c.category] = c.n;
    return {
      id: source.id,
      organizationName: source.organizationName,
      fhirBaseUrl: source.fhirBaseUrl,
      vendor: source.vendor,
      status: source.status,
      connectionId: connections.find((c) => c.sourceId === source.id)?.id ?? null,
      grantedScope: connections.find((c) => c.sourceId === source.id)?.scope ?? null,
      lastSyncedAt: source.lastSyncedAt,
      lastSyncStatus: source.lastSyncStatus,
      syncing: active.some((r) => r.sourceId === source.id),
      lastRunStats: lastFinished.find((r) => r.sourceId === source.id)?.stats ?? null,
      recordCount: counts.filter((c) => c.sourceId === source.id).reduce((sum, c) => sum + c.n, 0),
      categoryCounts,
    };
  });
}

// Deletes the organization with its tokens, stored records and sync history (cascades).
// Audit pattern G: the audit row is written only if the source is this person's, then the delete.
export async function deleteSource(scope: UserScope, sourceId: string, now: Date): Promise<boolean> {
  const [, deleted] = await scope.batch([
    auditFrom(scope, healthSource, eq(healthSource.id, sourceId), { action: "delete_source", sourceId: healthSource.id }, now),
    scope.delete(healthSource, eq(healthSource.id, sourceId)).returning({ id: healthSource.id }),
  ]);
  return deleted.length > 0;
}

// Connected sources that have never finished a sync and have none in progress.
export function needingFirstSync(sources: SourceSummary[]): SourceSummary[] {
  return sources.filter((s) => s.status === "connected" && !s.lastSyncedAt && !s.syncing && !s.lastSyncStatus);
}
