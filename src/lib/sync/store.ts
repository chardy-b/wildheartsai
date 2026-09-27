import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { contentHmac, sealField, unsealField, type UserKeys } from "@/lib/crypto/user-keys";
import { chunkBySize, insertRows, jsonValues } from "@/lib/db/bulk";
import { fhirResource, syncCursor, type SyncQueryStats } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { RecordSummary } from "@/lib/fhir/normalize";
import type { Resource } from "@/lib/fhir/types";
import { effectiveDate } from "./dates";
import { isEnteredInError, withoutMeta, type Diff, type Fetched, type Stored } from "./diff";
import type { Cursor, SyncQuery } from "./plan";

// Bump when normalize.ts changes what it produces, so stored summaries are rebuilt.
export const NORMALIZER_VERSION = 1;

const resourceField = (rowId: string) => ({ table: "fhir_resource", field: "resource", rowId });
const summaryField = (rowId: string) => ({ table: "fhir_resource", field: "summary", rowId });

export function prepareFetched(keys: UserKeys, resources: Resource[]): Fetched[] {
  return resources
    .filter((resource): resource is Resource & { id: string } => typeof resource.id === "string" && resource.id !== "")
    .map((resource) => ({
      resource,
      hmac: contentHmac(keys, withoutMeta(resource)),
      enteredInError: isEnteredInError(resource),
    }));
}

// Current rows this query's results could match: any with a fetched id (whatever
// category first stored them), plus, for removal checks, every row of the query's category.
export async function currentRows(
  db: Db,
  sourceId: string,
  query: Pick<SyncQuery, "resourceType" | "category">,
  fhirIds: string[],
  includeCategory: boolean,
): Promise<Stored[]> {
  const columns = {
    id: fhirResource.id,
    fhirId: fhirResource.fhirId,
    contentHmac: fhirResource.contentHmac,
    removedAt: fhirResource.removedAt,
    category: fhirResource.category,
  };
  const base = and(eq(fhirResource.sourceId, sourceId), eq(fhirResource.resourceType, query.resourceType), isNull(fhirResource.supersededAt));
  const found = new Map<string, Stored>();
  if (includeCategory) {
    for (const row of await db.select(columns).from(fhirResource).where(and(base, eq(fhirResource.category, query.category)))) {
      found.set(row.id, row);
    }
  }
  if (fhirIds.length > 0) {
    for (const row of await db.select(columns).from(fhirResource).where(and(base, inArray(fhirResource.fhirId, jsonValues(fhirIds))))) {
      found.set(row.id, row);
    }
  }
  return [...found.values()];
}

type Context = { userId: string; sourceId: string; organizationName: string; query: SyncQuery };

function sourceUpdatedAt(resource: Resource): { versionId: string | null; updatedAt: Date | null } {
  const meta = (resource as Resource & { meta?: { versionId?: string; lastUpdated?: string } }).meta;
  const updatedAt = meta?.lastUpdated ? new Date(meta.lastUpdated) : null;
  return { versionId: meta?.versionId ?? null, updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null };
}

function newRow(keys: UserKeys, context: Context, fetched: Fetched, now: Date): typeof fhirResource.$inferInsert {
  const id = randomUUID();
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

const rowSize = (row: typeof fhirResource.$inferInsert) => row.sealedResource.length + row.sealedSummary.length + 1_000;

// Applies one query's diff. D1 has no interactive transactions, so writes go in batches,
// each atomic: a changed record's old version is retired, its new version stored and the
// two linked in one batch. A failure part-way is safe to retry, because the retried step
// fetches again and diffs against what was stored.
export async function applyDiff(db: Db, keys: UserKeys, context: Context, diff: Diff, now: Date): Promise<ApplyCounts> {
  for (const rows of chunkBySize(diff.insert.map((f) => newRow(keys, context, f, now)), rowSize)) {
    await insertRows(db, fhirResource, rows);
  }

  const replacements = diff.supersede.map(({ stored, fetched }) => ({
    old: stored.id,
    // The new version takes this query's category and summary. An Observation that matches
    // two category searches is only re-stored when its content changes, so it can't flip back.
    row: newRow(keys, context, fetched, now),
  }));
  for (const chunk of chunkBySize(replacements, (r) => rowSize(r.row))) {
    const oldIds = jsonValues(chunk.map((r) => r.old));
    const links = JSON.stringify(chunk.map((r) => ({ old: r.old, new: r.row.id })));
    await db.batch([
      // Retire the old versions first: only one current version may exist at a time.
      db.update(fhirResource).set({ supersededAt: now }).where(inArray(fhirResource.id, oldIds)),
      insertRows(db, fhirResource, chunk.map((r) => r.row)),
      db
        .update(fhirResource)
        .set({ supersededBy: sql`(select value ->> '$.new' from json_each(${links}) where value ->> '$.old' = ${fhirResource.id})` })
        .where(inArray(fhirResource.id, oldIds)),
    ]);
  }

  const touch = (rows: Stored[], set: Partial<typeof fhirResource.$inferInsert>) =>
    db.update(fhirResource).set(set).where(inArray(fhirResource.id, jsonValues(rows.map((s) => s.id))));
  const updates = [
    ...(diff.unchanged.length ? [touch(diff.unchanged, { lastSeenAt: now })] : []),
    ...(diff.restore.length ? [touch(diff.restore, { lastSeenAt: now, removedAt: null })] : []),
    ...(diff.remove.length ? [touch(diff.remove, { removedAt: now })] : []),
  ];
  if (updates.length > 0) await db.batch(updates as [(typeof updates)[number], ...typeof updates]);

  return {
    inserted: diff.insert.length,
    superseded: diff.supersede.length,
    unchanged: diff.unchanged.length + diff.restore.length,
    removed: diff.remove.length,
  };
}

export async function readCursor(db: Db, sourceId: string, queryKey: string): Promise<Cursor | undefined> {
  const [row] = await db
    .select({ lastSuccessAt: syncCursor.lastSuccessAt, lastFullAt: syncCursor.lastFullAt, supportsLastUpdated: syncCursor.supportsLastUpdated })
    .from(syncCursor)
    .where(and(eq(syncCursor.sourceId, sourceId), eq(syncCursor.queryKey, queryKey)))
    .limit(1);
  return row;
}

export async function saveCursor(db: Db, sourceId: string, queryKey: string, patch: Partial<Cursor>): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db
    .insert(syncCursor)
    .values({ sourceId, queryKey, ...patch })
    .onConflictDoUpdate({ target: [syncCursor.sourceId, syncCursor.queryKey], set: patch });
}

export type StoredRecord = { id: string; resource: Resource; summary: RecordSummary };

// Decrypts one stored row. Only for the owner's keys; anything else fails to open.
export function openStoredRow(
  keys: UserKeys,
  row: Pick<typeof fhirResource.$inferSelect, "id" | "sealedResource" | "sealedSummary">,
): StoredRecord {
  return {
    id: row.id,
    resource: JSON.parse(unsealField(keys, row.sealedResource, resourceField(row.id))) as Resource,
    summary: JSON.parse(unsealField(keys, row.sealedSummary, summaryField(row.id))) as RecordSummary,
  };
}
