import { normalizePatient, type RecordCategory, type StoredSummary } from "@/lib/fhir/normalize";
import { RECORD_QUERIES } from "@/lib/records";

// Which searches a sync runs, and for each whether to pull everything or only what
// changed since the last sync.

export type SyncQuery = {
  // Stable id for sync_cursor and run stats, such as 'Observation:lab'.
  key: string;
  // Null for rows kept but not shown as records, such as the patient's own details.
  category: RecordCategory | null;
  resourceType: string;
  path: (patientId: string) => string;
  normalize: (resource: never, source: string) => StoredSummary;
  // A failure is kept in the stats but not reported to the person (see RECORD_QUERIES).
  optional?: boolean;
};

const patient = (id: string) => encodeURIComponent(id);

// Stored alongside the records, never listed as one.
const SUPPORT_QUERIES: SyncQuery[] = [
  { key: "Patient:self", category: null, resourceType: "Patient", path: (p) => `Patient?_id=${patient(p)}`, normalize: normalizePatient, optional: true },
];

export const SYNC_QUERIES: SyncQuery[] = [
  ...RECORD_QUERIES.map((query) => ({
    key: `${query.resourceType}:${query.category}`,
    category: query.category,
    resourceType: query.resourceType,
    path: query.path,
    normalize: query.normalize,
    optional: query.optional,
  })),
  ...SUPPORT_QUERIES,
];

// Sync is off the request path, so it can page much further than the live view.
export const SYNC_MAX_PAGES = 100;
export const SYNC_MAX_RESOURCES = 10_000;

// Incremental searches can't see deletions, so every query is pulled in full at least this often.
export const FULL_PULL_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
// Incremental searches start this far before the last success, to allow for clock skew
// and for records updated while that sync was running.
export const INCREMENTAL_OVERLAP_MS = 24 * 60 * 60 * 1000;

export type Cursor = {
  lastSuccessAt: Date | null;
  lastFullAt: Date | null;
  supportsLastUpdated: boolean | null;
};

export type QueryPlan = { mode: "full" } | { mode: "incremental"; since: Date };

export function planQuery(cursor: Cursor | undefined, now: Date): QueryPlan {
  if (!cursor?.lastSuccessAt || !cursor.lastFullAt || cursor.supportsLastUpdated !== true) return { mode: "full" };
  if (now.getTime() - cursor.lastFullAt.getTime() >= FULL_PULL_EVERY_MS) return { mode: "full" };
  return { mode: "incremental", since: new Date(cursor.lastSuccessAt.getTime() - INCREMENTAL_OVERLAP_MS) };
}

function withLastUpdated(path: string, since: Date): string {
  return `${path}&_lastUpdated=${encodeURIComponent(`gt${since.toISOString()}`)}`;
}

export function searchPath(query: SyncQuery, patientId: string, plan: QueryPlan): string {
  const path = query.path(patientId);
  return plan.mode === "incremental" ? withLastUpdated(path, plan.since) : path;
}

// Asks for records updated after tomorrow. A server that honours _lastUpdated returns
// nothing; one that ignores it returns the same records as the full search.
export function probePath(query: SyncQuery, patientId: string, now: Date): string {
  return withLastUpdated(query.path(patientId), new Date(now.getTime() + 24 * 60 * 60 * 1000));
}

// null when a probe can't tell (the full search found nothing to compare with).
export function interpretProbe(fullCount: number, probe: { count: number } | { error: true }): boolean | null {
  if ("error" in probe) return false;
  if (fullCount === 0) return null;
  return probe.count === 0;
}
