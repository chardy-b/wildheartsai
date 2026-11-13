import { CATEGORIES, categoryForSlug } from "@/lib/fhir/categories";
import type { RecordCategory } from "@/lib/fhir/normalize";
import type { SourceSummary } from "@/lib/sources";

// The timeline's filters, cursors and query strings: no database access, so the Cloudflare API
// (api/) and client components can import it. The queries are in ./timeline.ts.

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
