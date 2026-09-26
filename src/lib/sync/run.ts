import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { UserKeys } from "@/lib/crypto/user-keys";
import { healthSource, syncRun, type SyncQueryStats } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import type { Resource } from "@/lib/fhir/types";
import { diffResources } from "./diff";
import {
  interpretProbe,
  planQuery,
  probePath,
  searchPath,
  SYNC_MAX_PAGES,
  SYNC_MAX_RESOURCES,
  type Cursor,
  type SyncQuery,
} from "./plan";
import { applyDiff, currentRows, prepareFetched, readCursor, saveCursor } from "./store";

// One sync of one source, as separate steps so the job queue (stage 3) can run,
// retry and resume each on its own. Nothing here logs or returns record content.

export type SyncTrigger = "connect" | "manual" | "scheduled";

export type SyncSource = {
  runId: string;
  userId: string;
  sourceId: string;
  organizationName: string;
  fhirBaseUrl: string;
  patientId: string;
};

export type SyncDeps = {
  db: Db;
  keys: UserKeys;
  now: () => Date;
  accessToken: () => Promise<string>;
  search: (input: {
    baseUrl: string;
    path: string;
    resourceType: string;
    accessToken: string;
    maxPages: number;
    maxResources: number;
  }) => Promise<{ resources: Resource[]; truncated: boolean }>;
};

// A queued or running run older than this was lost (its job never ran or died without
// reporting), so it no longer blocks new runs.
export const STALE_RUN_MS = 3 * 60 * 60 * 1000;

// Queues a run unless one is already queued or running for the source (then returns that one).
export async function startRun(
  db: Db,
  input: { userId: string; sourceId: string; trigger: SyncTrigger },
  now: Date,
): Promise<{ runId: string; created: boolean }> {
  await db
    .update(syncRun)
    .set({ status: "failed", finishedAt: now })
    .where(
      and(
        eq(syncRun.sourceId, input.sourceId),
        inArray(syncRun.status, ["queued", "running"]),
        lt(sql`coalesce(${syncRun.startedAt}, ${syncRun.queuedAt})`, now.getTime() - STALE_RUN_MS),
      ),
    );
  const [created] = await db
    .insert(syncRun)
    .values({ ...input, status: "queued", queuedAt: now })
    .onConflictDoNothing()
    .returning({ id: syncRun.id });
  if (created) return { runId: created.id, created: true };
  const [active] = await db
    .select({ id: syncRun.id })
    .from(syncRun)
    .where(and(eq(syncRun.sourceId, input.sourceId), inArray(syncRun.status, ["queued", "running"])))
    .limit(1);
  if (!active) throw new Error("Sync run conflict without an active run");
  return { runId: active.id, created: false };
}

export async function beginRun(db: Db, runId: string, now: Date): Promise<void> {
  await db.update(syncRun).set({ status: "running", startedAt: now }).where(eq(syncRun.id, runId));
}

async function recordStats(db: Db, runId: string, key: string, stats: SyncQueryStats): Promise<void> {
  await db
    .update(syncRun)
    .set({ stats: sql`json_patch(${syncRun.stats}, ${JSON.stringify({ [key]: stats })})` })
    .where(eq(syncRun.id, runId));
}

// Error codes safe to store and log: an HTTP status or the client's own code, never a message.
function errorCodeOf(error: unknown): string {
  if (error instanceof EpicError) return String(error.status ?? error.code ?? "fhir");
  return "network";
}

async function probe(deps: SyncDeps, source: SyncSource, query: SyncQuery, accessToken: string, fullCount: number): Promise<boolean | null> {
  try {
    const { resources } = await deps.search({
      baseUrl: source.fhirBaseUrl,
      path: probePath(query, source.patientId, deps.now()),
      resourceType: query.resourceType,
      accessToken,
      maxPages: 1,
      maxResources: SYNC_MAX_RESOURCES,
    });
    return interpretProbe(fullCount, { count: resources.length });
  } catch (error) {
    if (error instanceof ReconnectRequiredError) throw error;
    return interpretProbe(fullCount, { error: true });
  }
}

// Fetches one query (in full or since the last sync), stores what's new or changed,
// and advances its cursor. A FHIR failure is recorded in the stats and doesn't stop
// the run; ReconnectRequiredError and database errors are thrown.
export async function syncQuery(deps: SyncDeps, source: SyncSource, query: SyncQuery): Promise<SyncQueryStats> {
  const startedAt = deps.now();
  const cursor = await readCursor(deps.db, source.sourceId, query.key);
  const plan = planQuery(cursor, startedAt);

  let fetched: { resources: Resource[]; truncated: boolean };
  let accessToken: string;
  try {
    accessToken = await deps.accessToken();
    fetched = await deps.search({
      baseUrl: source.fhirBaseUrl,
      path: searchPath(query, source.patientId, plan),
      resourceType: query.resourceType,
      accessToken,
      maxPages: SYNC_MAX_PAGES,
      maxResources: SYNC_MAX_RESOURCES,
    });
  } catch (error) {
    if (error instanceof ReconnectRequiredError) throw error;
    const stats = { fetched: 0, inserted: 0, superseded: 0, unchanged: 0, removed: 0, errorCode: errorCodeOf(error) };
    console.error(`[sync] ${query.key} failed ${stats.errorCode}`);
    await recordStats(deps.db, source.runId, query.key, stats);
    return stats;
  }

  const items = prepareFetched(deps.keys, fetched.resources);
  const complete = !fetched.truncated;
  const full = plan.mode === "full";
  const stored = await currentRows(
    deps.db,
    source.sourceId,
    query,
    items.map((i) => i.resource.id),
    full && complete,
  );
  const diff = diffResources(items, stored, full && complete ? { removalsIn: query.category } : {});
  const counts = await applyDiff(deps.db, deps.keys, { ...source, query }, diff, deps.now());

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
  await saveCursor(deps.db, source.sourceId, query.key, patch);

  const stats: SyncQueryStats = { fetched: fetched.resources.length, ...counts, ...(complete ? {} : { errorCode: "truncated" }) };
  if (!complete) console.error(`[sync] ${query.key} truncated`);
  await recordStats(deps.db, source.runId, query.key, stats);
  return stats;
}

export type RunStatus = "ok" | "partial" | "failed";

export function runStatusOf(stats: Record<string, SyncQueryStats>): RunStatus {
  const all = Object.values(stats);
  const failed = all.filter((s) => s.errorCode && s.errorCode !== "truncated").length;
  if (all.length > 0 && failed === all.length) return "failed";
  return all.some((s) => s.errorCode) ? "partial" : "ok";
}

export async function finishRun(db: Db, runId: string, now: Date): Promise<RunStatus> {
  const [run] = await db.select({ stats: syncRun.stats, sourceId: syncRun.sourceId }).from(syncRun).where(eq(syncRun.id, runId));
  const status = runStatusOf(run.stats);
  await db.batch([
    db.update(syncRun).set({ status, finishedAt: now }).where(eq(syncRun.id, runId)),
    db.update(healthSource).set({ lastSyncedAt: now, lastSyncStatus: status, updatedAt: now }).where(eq(healthSource.id, run.sourceId)),
  ]);
  return status;
}

// Ends a run that couldn't continue. When the source needs signing in again, marks it
// so the connections page asks the person to reconnect and background syncs skip it.
// One batch, so both land or neither; the source is only touched while the run is active.
export async function failRun(db: Db, runId: string, reason: "reconnect" | "error", now: Date): Promise<void> {
  const active = and(eq(syncRun.id, runId), inArray(syncRun.status, ["queued", "running"]));
  await db.batch([
    db
      .update(healthSource)
      .set({ lastSyncStatus: "failed", updatedAt: now, ...(reason === "reconnect" ? { status: "reconnect_required" as const } : {}) })
      .where(inArray(healthSource.id, db.select({ id: syncRun.sourceId }).from(syncRun).where(active))),
    db.update(syncRun).set({ status: "failed", finishedAt: now }).where(active),
  ]);
}
