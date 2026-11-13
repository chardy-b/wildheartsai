import { and, eq, inArray, sql } from "drizzle-orm";
import { EpicError, ReconnectRequiredError, failureDiagnostic } from "@/lib/epic/errors";
import type { Resource } from "@/lib/fhir/types";
import { diffResources } from "@/lib/sync/diff";
import { interpretProbe, planQuery, probePath, searchPath, SYNC_MAX_PAGES, SYNC_MAX_RESOURCES, type Cursor, type SyncQuery } from "@/lib/sync/plan";
import type { UserKeys } from "../../crypto/fields";
import { auditFrom } from "../../data/audit";
import type { UserScope } from "../../data/scope";
import { healthSource, syncRun, type SyncQueryStats } from "../../db/schema";
import { applyDiff, currentRows, prepareFetched, readCursor, saveCursor } from "./store";

// One sync of one source as separate steps (src/lib/sync/run.ts in the Next app). Every query
// runs in the source owner's scope. Nothing here logs or returns record content.

export type SyncSource = {
  runId: string;
  userId: string;
  sourceId: string;
  organizationName: string;
  fhirBaseUrl: string;
  patientId: string;
  // What the connection was granted (space-separated). Searches it doesn't cover are skipped.
  scope: string;
};

export type SyncDeps = {
  scope: UserScope;
  keys: UserKeys;
  now: () => Date;
  accessToken: () => Promise<string>;
  search: (input: { baseUrl: string; path: string; resourceType: string; accessToken: string; maxPages: number; maxResources: number }) => Promise<{ resources: Resource[]; truncated: boolean }>;
  // Reads one resource at an address inside the source (a note's Binary).
  read: (input: { baseUrl: string; path: string; accessToken: string }) => Promise<unknown>;
};

const ACTIVE: ("queued" | "running")[] = ["queued", "running"];

export async function beginRun(scope: UserScope, runId: string, now: Date): Promise<void> {
  await scope.update(syncRun, { status: "running", startedAt: now }, eq(syncRun.id, runId));
}

// Replaces one query's stats in the run (json_set: a retried query's stats replace its last ones).
export async function recordStats(scope: UserScope, runId: string, key: string, stats: SyncQueryStats): Promise<void> {
  await scope.update(syncRun, { stats: sql`json_set(${syncRun.stats}, ${`$."${key}"`}, json(${JSON.stringify(stats)}))` } as never, eq(syncRun.id, runId));
}

// Error codes safe to store and log: an HTTP status or the client's own code, never a message.
function errorCodeOf(error: unknown): string {
  if (error instanceof EpicError) return String(failureDiagnostic(error).httpStatus ?? failureDiagnostic(error).failureCode);
  return "network";
}

async function probe(deps: SyncDeps, source: SyncSource, query: SyncQuery, accessToken: string, fullCount: number): Promise<boolean | null> {
  try {
    const { resources } = await deps.search({ baseUrl: source.fhirBaseUrl, path: probePath(query, source.patientId, deps.now()), resourceType: query.resourceType, accessToken, maxPages: 1, maxResources: SYNC_MAX_RESOURCES });
    return interpretProbe(fullCount, { count: resources.length });
  } catch (error) {
    if (error instanceof ReconnectRequiredError) throw error;
    return interpretProbe(fullCount, { error: true });
  }
}

// Fetches one query (in full or since the last sync), stores what's new or changed, and advances
// its cursor. A FHIR failure is recorded in the stats and doesn't stop the run;
// ReconnectRequiredError and database errors are thrown.
export async function syncQuery(deps: SyncDeps, source: SyncSource, query: SyncQuery): Promise<SyncQueryStats> {
  const startedAt = deps.now();
  const cursor = await readCursor(deps.scope, source.sourceId, query.key);
  const plan = planQuery(cursor, startedAt);

  let fetched: { resources: Resource[]; truncated: boolean };
  let accessToken: string;
  try {
    accessToken = await deps.accessToken();
    fetched = await deps.search({ baseUrl: source.fhirBaseUrl, path: searchPath(query, source.patientId, plan), resourceType: query.resourceType, accessToken, maxPages: SYNC_MAX_PAGES, maxResources: SYNC_MAX_RESOURCES });
  } catch (error) {
    if (error instanceof ReconnectRequiredError) throw error;
    const stats: SyncQueryStats = {
      fetched: 0, inserted: 0, superseded: 0, unchanged: 0, removed: 0,
      errorCode: errorCodeOf(error),
      ...failureDiagnostic(error),
      ...(query.optional ? { optional: true } : {}),
    };
    console.error("[sync] query failed", failureDiagnostic(error));
    await recordStats(deps.scope, source.runId, query.key, stats);
    return stats;
  }

  const items = prepareFetched(deps.keys, fetched.resources);
  const complete = !fetched.truncated;
  const full = plan.mode === "full";
  const stored = await currentRows(deps.scope, source.sourceId, query, items.map((i) => i.resource.id), full && complete);
  // Only a complete full pull shows what's gone, and only rows shown as records are checked.
  const removalsIn = full && complete && query.category !== null ? query.category : undefined;
  const diff = diffResources(items, stored, { removalsIn });
  const counts = await applyDiff(deps.scope, deps.keys, { ...source, query }, diff, deps.now());

  // A truncated pull didn't see everything, so the cursor stays where it was.
  const patch: Partial<Cursor> = {};
  if (complete) patch.lastSuccessAt = startedAt;
  if (complete && full) {
    patch.lastFullAt = startedAt;
    if (cursor?.supportsLastUpdated == null && items.length > 0) {
      const supported = await probe(deps, source, query, accessToken, items.length);
      if (supported !== null) patch.supportsLastUpdated = supported;
    }
  }
  await saveCursor(deps.scope, source.sourceId, query.key, patch);

  const stats: SyncQueryStats = {
    fetched: fetched.resources.length,
    ...counts,
    ...(complete ? {} : { errorCode: "truncated" }),
    ...(query.optional ? { optional: true } : {}),
  };
  if (!complete) console.error(`[sync] ${query.key} truncated`);
  await recordStats(deps.scope, source.runId, query.key, stats);
  return stats;
}

export type RunStatus = "ok" | "partial" | "failed";

export function runStatusOf(stats: Record<string, SyncQueryStats>): RunStatus {
  const all = Object.values(stats);
  // Failures of optional searches (not every organization supports them) don't count.
  const counted = all.filter((s) => !s.optional);
  const failed = counted.filter((s) => s.errorCode && s.errorCode !== "truncated").length;
  if (counted.length > 0 && failed === counted.length) return "failed";
  return counted.some((s) => s.errorCode) ? "partial" : "ok";
}

// Ends a run with its status: read, then one batch guarded on the run still being active, so a
// retried finish step neither audits twice nor overwrites a failure.
export async function finishRun(scope: UserScope, runId: string, now: Date): Promise<RunStatus> {
  const [run] = await scope.selectFields(syncRun, { stats: syncRun.stats, sourceId: syncRun.sourceId, trigger: syncRun.trigger, status: syncRun.status }, eq(syncRun.id, runId)).limit(1);
  if (!run) throw new Error("Sync run missing");
  if (!ACTIVE.includes(run.status as "queued" | "running")) return run.status as RunStatus;
  const status = runStatusOf(run.stats);
  const inserted = Object.values(run.stats).reduce((sum, s) => sum + s.inserted + s.superseded, 0);
  const failure = Object.values(run.stats).find((s) => s.failureCode);
  const diagnostic = failure?.failureCode
    ? { failureCode: failure.failureCode, failureStage: failure.failureStage ?? ("app" as const), ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}) }
    : {};
  // Audit pattern G: the audit row and the source's update are guarded on the run still being
  // active when the batch runs; the run's own update comes last.
  const active = and(eq(syncRun.id, runId), inArray(syncRun.status, ACTIVE))!;
  await scope.batch([
    auditFrom(scope, syncRun, active, { action: "sync", sourceId: syncRun.sourceId, detail: { trigger: run.trigger, status, inserted, ...diagnostic } }, now),
    scope.update(healthSource, { lastSyncedAt: now, lastSyncStatus: status, updatedAt: now }, and(eq(healthSource.id, run.sourceId), sql`exists (select 1 from ${syncRun} where ${active})`)),
    scope.update(syncRun, { status, finishedAt: now }, active),
  ]);
  return status;
}
