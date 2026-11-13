import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { RecordItem, RecordSummary } from "@/lib/fhir/normalize";
import { collectReferences, REFERENCED_TYPES, referencedName, withNames } from "@/lib/fhir/references";
import type { Resource } from "@/lib/fhir/types";
import { NORMALIZER_VERSION, SYNC_QUERIES, type SyncQuery } from "@/lib/sync/plan";
import { PAGE_SIZE, type TimelineCursor, type TimelineFilters } from "@/lib/timeline-filters";
import { hmacFor, unsealField, type UserKeys } from "../crypto/fields";
import { fhirAttachment, fhirResource } from "../db/schema";
import { inSlices, type UserScope } from "./scope";
import type { SourceSummary } from "./sources";

// The unified timeline (src/lib/timeline.ts and the read half of src/lib/sync/store.ts in the
// Next app): every stored record from every source, newest first, one page at a time with keyset
// pagination on (effective_at desc nulls last, id desc). Lists that can exceed D1's 100 bound
// parameters per statement are queried in slices.

export type TimelinePage = { items: RecordItem[]; next: TimelineCursor | null };
type StoredRecord = { id: string; resource: Resource; summary: RecordSummary };

const resourceField = (rowId: string) => ({ table: "fhir_resource", field: "resource", rowId });
const summaryField = (rowId: string) => ({ table: "fhir_resource", field: "summary", rowId });

export function openStoredRow(keys: UserKeys, row: { id: string; sealedResource: string; sealedSummary: string }): StoredRecord {
  return {
    id: row.id,
    resource: JSON.parse(unsealField(keys, row.sealedResource, resourceField(row.id))) as Resource,
    summary: JSON.parse(unsealField(keys, row.sealedSummary, summaryField(row.id))) as RecordSummary,
  };
}

const NORMALIZERS = new Map(SYNC_QUERIES.map((q) => [q.category, q.normalize]));

// A stored row as the timeline shows it: the summary is recomputed when an older normalizer made
// it, or when `names` fills in a name a reference didn't carry.
export function openForDisplay(
  keys: UserKeys,
  row: { id: string; sealedResource: string; sealedSummary: string; normalizerVersion: number; category: string | null },
  names?: Map<string, string>,
): StoredRecord {
  const opened = openStoredRow(keys, row);
  const named = names ? withNames(opened.resource, names) : opened.resource;
  if (row.normalizerVersion >= NORMALIZER_VERSION && named === opened.resource) return opened;
  const normalize = NORMALIZERS.get(row.category as SyncQuery["category"]);
  if (!normalize) return opened;
  return { ...opened, summary: normalize(named as never, opened.summary.source) as RecordSummary };
}

function afterCursor(cursor: TimelineCursor): SQL | undefined {
  const { effectiveAt, id } = fhirResource;
  if (!cursor.at) return and(isNull(effectiveAt), lt(id, cursor.id));
  return or(lt(effectiveAt, cursor.at), and(eq(effectiveAt, cursor.at), lt(id, cursor.id)), isNull(effectiveAt));
}

export async function timelinePage(
  scope: UserScope,
  keys: UserKeys,
  sources: SourceSummary[],
  filters: TimelineFilters,
  cursor: TimelineCursor | null,
  limit = PAGE_SIZE,
): Promise<TimelinePage> {
  const sourceIds = filters.sourceIds.length ? filters.sourceIds : sources.map((s) => s.id);
  if (sourceIds.length === 0) return { items: [], next: null };
  const conditions: (SQL | undefined)[] = [
    inArray(fhirResource.sourceId, sourceIds),
    isNull(fhirResource.supersededAt),
    isNull(fhirResource.removedAt),
    // Rows without a category (the patient's own details) are kept, not listed.
    isNotNull(fhirResource.category),
  ];
  if (filters.categories.length) conditions.push(inArray(fhirResource.category, filters.categories));
  if (filters.from) conditions.push(gte(fhirResource.effectiveAt, new Date(`${filters.from}T00:00:00Z`)));
  if (filters.to) conditions.push(lt(fhirResource.effectiveAt, new Date(Date.parse(`${filters.to}T00:00:00Z`) + 86_400_000)));
  if (cursor) conditions.push(afterCursor(cursor));

  const rows = await scope
    .selectFields(
      fhirResource,
      {
        id: fhirResource.id,
        sourceId: fhirResource.sourceId,
        resourceType: fhirResource.resourceType,
        fhirId: fhirResource.fhirId,
        effectiveAt: fhirResource.effectiveAt,
        sealedResource: fhirResource.sealedResource,
        sealedSummary: fhirResource.sealedSummary,
        normalizerVersion: fhirResource.normalizerVersion,
        category: fhirResource.category,
      },
      and(...conditions),
    )
    .orderBy(sql`${fhirResource.effectiveAt} desc nulls last`, sql`${fhirResource.id} desc`)
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next = rows.length > limit && last ? { at: last.effectiveAt, id: last.id } : null;
  const history = await earlierVersions(scope, keys, page);
  const referenced = await referencedResources(scope, keys, page);
  const bySource = new Map(sources.map((s) => [s.id, s]));
  const items = page.flatMap((row): RecordItem[] => {
    const source = bySource.get(row.sourceId);
    if (!source) return [];
    const linkedHere = referenced.get(row.sourceId);
    const { resource, summary } = openForDisplay(keys, row, linkedHere?.names);
    const linked = linkedHere
      ? collectReferences(resource).flatMap((key) => {
          const found = linkedHere.resources.get(key);
          return found ? [{ key, resource: found }] : [];
        })
      : [];
    return [
      {
        ...summary,
        source: source.organizationName,
        sourceId: source.id,
        resource,
        connectionId: source.connectionId ?? "",
        history: history.get(`${row.sourceId}|${row.resourceType}|${row.fhirId}`) ?? [],
        linked,
      },
    ];
  });
  return { items, next };
}

// Every record matching the filters, across all pages, for export.
export async function allMatching(scope: UserScope, keys: UserKeys, sources: SourceSummary[], filters: TimelineFilters, pageSize = 500): Promise<RecordItem[]> {
  const items: RecordItem[] = [];
  let cursor: TimelineCursor | null = null;
  do {
    const page: TimelinePage = await timelinePage(scope, keys, sources, filters, cursor, pageSize);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return items;
}

// Every visible note, for listing a visit's notes inside its detail whatever page they're on.
export async function allNotes(scope: UserScope, keys: UserKeys, sources: SourceSummary[]): Promise<RecordItem[]> {
  const page = await timelinePage(scope, keys, sources, { sourceIds: [], categories: ["note"], from: null, to: null }, null, 10_000);
  return page.items;
}

// The stored resources these rows point to, per source, by "Type/id", with the names they go by.
async function referencedResources(
  scope: UserScope,
  keys: UserKeys,
  page: { id: string; sourceId: string; sealedResource: string; sealedSummary: string }[],
): Promise<Map<string, { resources: Map<string, Resource>; names: Map<string, string> }>> {
  const found = new Map<string, { resources: Map<string, Resource>; names: Map<string, string> }>();
  const wanted = new Set<string>();
  for (const row of page) for (const key of collectReferences(openStoredRow(keys, row).resource)) wanted.add(`${row.sourceId}|${key}`);
  if (wanted.size === 0) return found;
  const fhirIds = [...new Set([...wanted].map((w) => w.slice(w.lastIndexOf("/") + 1)))];
  const sourceIds = [...new Set(page.map((r) => r.sourceId))];
  const rows = await inSlices(fhirIds, (slice) =>
    scope.selectFields(
      fhirResource,
      {
        id: fhirResource.id,
        sourceId: fhirResource.sourceId,
        resourceType: fhirResource.resourceType,
        fhirId: fhirResource.fhirId,
        sealedResource: fhirResource.sealedResource,
        sealedSummary: fhirResource.sealedSummary,
      },
      and(
        inArray(fhirResource.sourceId, sourceIds),
        isNull(fhirResource.category),
        isNull(fhirResource.supersededAt),
        inArray(fhirResource.resourceType, [...REFERENCED_TYPES]),
        inArray(fhirResource.fhirId, slice),
      ),
    ),
  );
  for (const row of rows) {
    const key = `${row.resourceType}/${row.fhirId}`;
    if (!wanted.has(`${row.sourceId}|${key}`)) continue;
    const entry = found.get(row.sourceId) ?? { resources: new Map(), names: new Map() };
    const { resource } = openStoredRow(keys, row);
    entry.resources.set(key, resource);
    const name = referencedName(resource);
    if (name) entry.names.set(key, name);
    found.set(row.sourceId, entry);
  }
  return found;
}

// Superseded versions of the given rows' resources, newest first, keyed source|type|id.
async function earlierVersions(
  scope: UserScope,
  keys: UserKeys,
  rows: { sourceId: string; resourceType: string; fhirId: string }[],
): Promise<Map<string, NonNullable<RecordItem["history"]>>> {
  const found = new Map<string, NonNullable<RecordItem["history"]>>();
  if (rows.length === 0) return found;
  const old = await inSlices([...new Set(rows.map((r) => r.fhirId))], (slice) =>
    scope.selectFields(
      fhirResource,
      {
        id: fhirResource.id,
        sourceId: fhirResource.sourceId,
        resourceType: fhirResource.resourceType,
        fhirId: fhirResource.fhirId,
        supersededAt: fhirResource.supersededAt,
        sealedResource: fhirResource.sealedResource,
        sealedSummary: fhirResource.sealedSummary,
      },
      and(isNotNull(fhirResource.supersededAt), inArray(fhirResource.fhirId, slice)),
    ),
  );
  // Newest first across slices.
  old.sort((a, b) => (b.supersededAt?.getTime() ?? 0) - (a.supersededAt?.getTime() ?? 0));
  const wanted = new Set(rows.map((r) => `${r.sourceId}|${r.resourceType}|${r.fhirId}`));
  for (const row of old) {
    const key = `${row.sourceId}|${row.resourceType}|${row.fhirId}`;
    if (!wanted.has(key) || !row.supersededAt) continue;
    const list = found.get(key) ?? [];
    list.push({ replacedAt: row.supersededAt.toISOString(), resource: openStoredRow(keys, row).resource });
    found.set(key, list);
  }
  return found;
}

// A note's stored text: undefined when not stored, null when stored but not readable as text.
export async function storedNoteText(scope: UserScope, keys: UserKeys, sourceId: string, url: string): Promise<string | null | undefined> {
  const [row] = await scope
    .selectFields(fhirAttachment, { id: fhirAttachment.id, sealedText: fhirAttachment.sealedText }, and(eq(fhirAttachment.sourceId, sourceId), eq(fhirAttachment.urlHmac, hmacFor(keys, url))))
    .limit(1);
  if (!row) return undefined;
  return row.sealedText === null ? null : unsealField(keys, row.sealedText, { table: "fhir_attachment", field: "text", rowId: row.id });
}
