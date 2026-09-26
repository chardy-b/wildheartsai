import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { UserKeys } from "@/lib/crypto/user-keys";
import { fhirResource } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { CATEGORIES, categoryForSlug } from "@/lib/fhir/categories";
import type { RecordCategory, RecordItem } from "@/lib/fhir/normalize";
import type { SourceSummary } from "@/lib/sources";
import { openStoredRow } from "@/lib/sync/store";

// The unified timeline: every stored record from every source, newest first, read one
// page at a time with keyset pagination on (effective_at desc nulls last, id desc).

export const PAGE_SIZE = 100;

export type TimelineFilters = {
  sourceIds: string[];
  categories: RecordCategory[];
  // Inclusive days, as YYYY-MM-DD. A date filter leaves out undated records.
  from: string | null;
  to: string | null;
};

// Where the next page starts: after this row. `at` is null inside the undated tail.
export type TimelineCursor = { at: Date | null; id: string };

export type TimelinePage = { items: RecordItem[]; next: TimelineCursor | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function values(param: string | string[] | undefined): string[] {
  return param === undefined ? [] : Array.isArray(param) ? param : [param];
}

function validDay(value: string | undefined): string | null {
  if (!value || !DAY.test(value)) return null;
  return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? null : value;
}

// Reads filters from the query string, keeping only the person's own sources and known types.
export function parseFilters(params: Record<string, string | string[] | undefined>, sources: SourceSummary[]): TimelineFilters {
  const owned = new Set(sources.map((s) => s.id));
  return {
    sourceIds: [...new Set(values(params.org).filter((id) => owned.has(id)))],
    categories: [...new Set(values(params.type).map(categoryForSlug).filter((c): c is RecordCategory => c !== undefined))],
    from: validDay(values(params.from)[0]),
    to: validDay(values(params.to)[0]),
  };
}

export function parseCursor(value: string | string[] | undefined): TimelineCursor | null {
  const raw = values(value)[0];
  if (!raw) return null;
  const split = raw.lastIndexOf("_");
  const [at, id] = [raw.slice(0, split), raw.slice(split + 1)];
  if (!UUID.test(id)) return null;
  if (at === "undated") return { at: null, id };
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : { at: date, id };
}

export function encodeCursor(cursor: TimelineCursor): string {
  return `${cursor.at ? cursor.at.toISOString() : "undated"}_${cursor.id}`;
}

// The query string for these filters (and optionally a page), for links and forms.
export function filterQuery(filters: TimelineFilters, cursor?: TimelineCursor | null): string {
  const params = new URLSearchParams();
  for (const id of filters.sourceIds) params.append("org", id);
  for (const category of filters.categories) {
    const slug = CATEGORIES.find((c) => c.category === category)?.slug;
    if (slug) params.append("type", slug);
  }
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (cursor) params.set("before", encodeCursor(cursor));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function hasFilters(filters: TimelineFilters): boolean {
  return filters.sourceIds.length > 0 || filters.categories.length > 0 || filters.from !== null || filters.to !== null;
}

function afterCursor(cursor: TimelineCursor): SQL | undefined {
  const { effectiveAt, id } = fhirResource;
  if (!cursor.at) return and(isNull(effectiveAt), lt(id, cursor.id));
  return or(lt(effectiveAt, cursor.at), and(eq(effectiveAt, cursor.at), lt(id, cursor.id)), isNull(effectiveAt));
}

export async function timelinePage(
  db: Db,
  keys: UserKeys,
  userId: string,
  sources: SourceSummary[],
  filters: TimelineFilters,
  cursor: TimelineCursor | null,
  limit = PAGE_SIZE,
): Promise<TimelinePage> {
  const sourceIds = filters.sourceIds.length ? filters.sourceIds : sources.map((s) => s.id);
  if (sourceIds.length === 0) return { items: [], next: null };
  const conditions: (SQL | undefined)[] = [
    eq(fhirResource.userId, userId),
    inArray(fhirResource.sourceId, sourceIds),
    isNull(fhirResource.supersededAt),
    isNull(fhirResource.removedAt),
  ];
  if (filters.categories.length) conditions.push(inArray(fhirResource.category, filters.categories));
  if (filters.from) conditions.push(gte(fhirResource.effectiveAt, new Date(`${filters.from}T00:00:00Z`)));
  if (filters.to) conditions.push(lt(fhirResource.effectiveAt, new Date(Date.parse(`${filters.to}T00:00:00Z`) + 86_400_000)));
  if (cursor) conditions.push(afterCursor(cursor));

  const rows = await db
    .select({
      id: fhirResource.id,
      sourceId: fhirResource.sourceId,
      resourceType: fhirResource.resourceType,
      fhirId: fhirResource.fhirId,
      effectiveAt: fhirResource.effectiveAt,
      sealedResource: fhirResource.sealedResource,
      sealedSummary: fhirResource.sealedSummary,
    })
    .from(fhirResource)
    .where(and(...conditions))
    .orderBy(sql`${fhirResource.effectiveAt} desc nulls last`, sql`${fhirResource.id} desc`)
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next = rows.length > limit && last ? { at: last.effectiveAt, id: last.id } : null;
  const history = await earlierVersions(db, keys, userId, page);
  const bySource = new Map(sources.map((s) => [s.id, s]));
  const items = page.flatMap((row): RecordItem[] => {
    const source = bySource.get(row.sourceId);
    if (!source) return [];
    const { resource, summary } = openStoredRow(keys, row);
    return [
      {
        ...summary,
        source: source.organizationName,
        sourceId: source.id,
        resource,
        connectionId: source.connectionId ?? "",
        history: history.get(`${row.sourceId}|${row.resourceType}|${row.fhirId}`) ?? [],
      },
    ];
  });
  return { items, next };
}

// Superseded versions of the given rows' resources, newest first, keyed source|type|id.
async function earlierVersions(
  db: Db,
  keys: UserKeys,
  userId: string,
  rows: { sourceId: string; resourceType: string; fhirId: string }[],
): Promise<Map<string, NonNullable<RecordItem["history"]>>> {
  const found = new Map<string, NonNullable<RecordItem["history"]>>();
  if (rows.length === 0) return found;
  const old = await db
    .select({
      id: fhirResource.id,
      sourceId: fhirResource.sourceId,
      resourceType: fhirResource.resourceType,
      fhirId: fhirResource.fhirId,
      supersededAt: fhirResource.supersededAt,
      sealedResource: fhirResource.sealedResource,
      sealedSummary: fhirResource.sealedSummary,
    })
    .from(fhirResource)
    .where(
      and(
        eq(fhirResource.userId, userId),
        isNotNull(fhirResource.supersededAt),
        inArray(fhirResource.fhirId, [...new Set(rows.map((r) => r.fhirId))]),
      ),
    )
    .orderBy(sql`${fhirResource.supersededAt} desc`);
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

// Every visible note, for listing a visit's notes inside its detail whatever page the notes are on.
export async function allNotes(db: Db, keys: UserKeys, userId: string, sources: SourceSummary[]): Promise<RecordItem[]> {
  const page = await timelinePage(db, keys, userId, sources, { sourceIds: [], categories: ["note"], from: null, to: null }, null, 10_000);
  return page.items;
}

// Per-category totals across the chosen sources (all, when none are chosen).
export function countsFor(sources: SourceSummary[], filters: TimelineFilters): Record<RecordCategory, number> {
  const counts = Object.fromEntries(CATEGORIES.map(({ category }) => [category, 0])) as Record<RecordCategory, number>;
  for (const source of sources) {
    if (filters.sourceIds.length && !filters.sourceIds.includes(source.id)) continue;
    for (const { category } of CATEGORIES) counts[category] += source.categoryCounts[category] ?? 0;
  }
  return counts;
}

// A stable color per organization, by the order they were connected.
export const SOURCE_TONES = 6;
export function sourceTones(sources: SourceSummary[]): Record<string, number> {
  return Object.fromEntries(sources.map((s, i) => [s.id, i % SOURCE_TONES]));
}
