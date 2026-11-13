import { and, eq, isNull, sql } from "drizzle-orm";
import type { Resource } from "@/lib/fhir/types";
import { effectiveDate } from "@/lib/sync/dates";
import { isEnteredInError, withoutMeta, type Diff, type Fetched, type Stored } from "@/lib/sync/diff";
import { NORMALIZER_VERSION, type Cursor, type SyncQuery } from "@/lib/sync/plan";
import { contentHmac, sealField, type UserKeys } from "../../crypto/fields";
import { inJson, type Statement, type UserScope } from "../../data/scope";
import { fhirResource, syncCursor, type SyncQueryStats } from "../../db/schema";

// Writing fetched records (the write half of src/lib/sync/store.ts in the Next app). Postgres
// applied one search's changes in one transaction. D1 can't hold a transaction that large, so
// changes are written in chunks, each an atomic batch, and every chunk can be redone: a retried
// step reads what's stored, diffs again, and writes only what's still missing. A replaced version
// is retired, its successor inserted and the two linked in the same batch, so "one current version
// per resource" (fhir_resource_current_idx) always holds.

const PAIRS_PER_BATCH = 50;
const IDS_PER_UPDATE = 5_000;
const STATEMENTS_PER_BATCH = 8;

const resourceField = (rowId: string) => ({ table: "fhir_resource", field: "resource", rowId });
const summaryField = (rowId: string) => ({ table: "fhir_resource", field: "summary", rowId });

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export function prepareFetched(keys: UserKeys, resources: Resource[]): Fetched[] {
  return resources
    .filter((resource): resource is Resource & { id: string } => typeof resource.id === "string" && resource.id !== "")
    .map((resource) => ({ resource, hmac: contentHmac(keys, withoutMeta(resource)), enteredInError: isEnteredInError(resource) }));
}

// Current rows this query's results could match: any with a fetched id (whatever category first
// stored them), plus, for removal checks, every row of the query's category.
export async function currentRows(
  scope: UserScope,
  sourceId: string,
  query: Pick<SyncQuery, "resourceType" | "category">,
  fhirIds: string[],
  includeCategory: boolean,
): Promise<Stored[]> {
  const columns = { id: fhirResource.id, fhirId: fhirResource.fhirId, contentHmac: fhirResource.contentHmac, removedAt: fhirResource.removedAt, category: fhirResource.category };
  const base = and(eq(fhirResource.sourceId, sourceId), eq(fhirResource.resourceType, query.resourceType), isNull(fhirResource.supersededAt));
  const found = new Map<string, Stored>();
  if (includeCategory && query.category !== null) {
    for (const row of await scope.selectFields(fhirResource, columns, and(base, eq(fhirResource.category, query.category)))) found.set(row.id, row);
  }
  if (fhirIds.length) {
    for (const row of await scope.selectFields(fhirResource, columns, and(base, inJson(fhirResource.fhirId, fhirIds)))) found.set(row.id, row);
  }
  return [...found.values()];
}

export type Context = { userId: string; sourceId: string; organizationName: string; query: Pick<SyncQuery, "category" | "normalize"> };

function sourceUpdatedAt(resource: Resource): { versionId: string | null; updatedAt: Date | null } {
  const meta = (resource as Resource & { meta?: { versionId?: string; lastUpdated?: string } }).meta;
  const updatedAt = meta?.lastUpdated ? new Date(meta.lastUpdated) : null;
  return { versionId: meta?.versionId ?? null, updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null };
}

function newRow(keys: UserKeys, context: Context, fetched: Fetched, now: Date): typeof fhirResource.$inferInsert {
  const id = crypto.randomUUID();
  const summary = context.query.normalize(fetched.resource as never, context.organizationName);
  const date = effectiveDate(summary.date);
  const meta = sourceUpdatedAt(fetched.resource);
  return {
    id,
    userId: context.userId,
    sourceId: context.sourceId,
    resourceType: fetched.resource.resourceType,
    fhirId: fetched.resource.id,
    category: context.query.category,
    effectiveAt: date?.at ?? null,
    datePrecision: date?.precision ?? null,
    sourceVersionId: meta.versionId,
    sourceUpdatedAt: meta.updatedAt,
    contentHmac: fetched.hmac,
    sealedResource: sealField(keys, JSON.stringify(fetched.resource), resourceField(id)),
    sealedSummary: sealField(keys, JSON.stringify(summary), summaryField(id)),
    normalizerVersion: NORMALIZER_VERSION,
    firstSeenAt: now,
    lastSeenAt: now,
    removedAt: fetched.enteredInError ? now : null,
  };
}

export type ApplyCounts = Omit<SyncQueryStats, "fetched" | "errorCode">;

async function inBatches(scope: UserScope, statements: Statement[]): Promise<void> {
  for (const group of chunks(statements, STATEMENTS_PER_BATCH)) await scope.batch(group);
}

// Applies one query's diff, chunk by chunk (see the top of this file).
export async function applyDiff(scope: UserScope, keys: UserKeys, context: Context, diff: Diff, now: Date): Promise<ApplyCounts> {
  await inBatches(scope, scope.bulkInsert(fhirResource, diff.insert.map((f) => newRow(keys, context, f, now))));

  for (const pairs of chunks(diff.supersede, PAIRS_PER_BATCH)) {
    // The new version takes this query's category and summary.
    const replaced = pairs.map(({ stored, fetched }) => ({ old: stored.id, row: newRow(keys, context, fetched, now) }));
    const olds = replaced.map((r) => r.old);
    const links = JSON.stringify(replaced.map((r) => ({ old: r.old, new: r.row.id })));
    await scope.batch([
      // Retire the old versions first: only one current version may exist at a time.
      scope.update(fhirResource, { supersededAt: now }, inJson(fhirResource.id, olds)),
      ...scope.bulkInsert(fhirResource, replaced.map((r) => r.row)),
      scope.update(
        fhirResource,
        { supersededBy: sql`(select json_extract(value, '$.new') from json_each(${links}) where json_extract(value, '$.old') = ${fhirResource.id})` } as never,
        inJson(fhirResource.id, olds),
      ),
    ]);
  }

  const updates: Statement[] = [];
  for (const ids of chunks(diff.unchanged.map((s) => s.id), IDS_PER_UPDATE)) updates.push(scope.update(fhirResource, { lastSeenAt: now }, inJson(fhirResource.id, ids)));
  for (const ids of chunks(diff.restore.map((s) => s.id), IDS_PER_UPDATE)) updates.push(scope.update(fhirResource, { lastSeenAt: now, removedAt: null }, inJson(fhirResource.id, ids)));
  for (const ids of chunks(diff.remove.map((s) => s.id), IDS_PER_UPDATE)) updates.push(scope.update(fhirResource, { removedAt: now }, inJson(fhirResource.id, ids)));
  await inBatches(scope, updates);

  return { inserted: diff.insert.length, superseded: diff.supersede.length, unchanged: diff.unchanged.length + diff.restore.length, removed: diff.remove.length };
}

export async function readCursor(scope: UserScope, sourceId: string, queryKey: string): Promise<Cursor | undefined> {
  const [row] = await scope
    .selectFields(
      syncCursor,
      { lastSuccessAt: syncCursor.lastSuccessAt, lastFullAt: syncCursor.lastFullAt, supportsLastUpdated: syncCursor.supportsLastUpdated },
      and(eq(syncCursor.sourceId, sourceId), eq(syncCursor.queryKey, queryKey)),
    )
    .limit(1);
  return row;
}

export async function saveCursor(scope: UserScope, sourceId: string, queryKey: string, patch: Partial<Cursor>): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await scope.upsertCursor(sourceId, queryKey, patch);
}
