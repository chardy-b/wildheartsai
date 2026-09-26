import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { contentHmac, sealField, unsealField, type UserKeys } from "@/lib/crypto/user-keys";
import { fhirResource, syncCursor, type SyncQueryStats } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { RecordSummary } from "@/lib/fhir/normalize";
import type { Resource } from "@/lib/fhir/types";
import { effectiveDate } from "./dates";
import { isEnteredInError, withoutMeta, type Diff, type Fetched, type Stored } from "./diff";
import type { Cursor, SyncQuery } from "./plan";

// Bump when normalize.ts changes what it produces, so stored summaries are rebuilt.
export const NORMALIZER_VERSION = 1;

const BATCH = 100;

function chunks<T>(values: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

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
  for (const ids of chunks(fhirIds, 1000)) {
    for (const row of await db.select(columns).from(fhirResource).where(and(base, inArray(fhirResource.fhirId, ids)))) {
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

// Applies one query's diff in a single transaction.
export async function applyDiff(db: Db, keys: UserKeys, context: Context, diff: Diff, now: Date): Promise<ApplyCounts> {
  await db.transaction(async (tx) => {
    for (const batch of chunks(diff.insert)) {
      await tx.insert(fhirResource).values(batch.map((f) => newRow(keys, context, f, now)));
    }
    for (const { stored, fetched } of diff.supersede) {
      // Retire the old version first: only one current version may exist at a time.
      await tx.update(fhirResource).set({ supersededAt: now }).where(eq(fhirResource.id, stored.id));
      // The new version takes this query's category and summary. An Observation that matches
      // two category searches is only re-stored when its content changes, so it can't flip back.
      const row = newRow(keys, context, fetched, now);
      await tx.insert(fhirResource).values(row);
      await tx.update(fhirResource).set({ supersededBy: row.id }).where(eq(fhirResource.id, stored.id));
    }
    for (const batch of chunks(diff.unchanged)) {
      await tx.update(fhirResource).set({ lastSeenAt: now }).where(inArray(fhirResource.id, batch.map((s) => s.id)));
    }
    for (const batch of chunks(diff.restore)) {
      await tx
        .update(fhirResource)
        .set({ lastSeenAt: now, removedAt: null })
        .where(inArray(fhirResource.id, batch.map((s) => s.id)));
    }
    for (const batch of chunks(diff.remove)) {
      await tx.update(fhirResource).set({ removedAt: now }).where(inArray(fhirResource.id, batch.map((s) => s.id)));
    }
  });
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
