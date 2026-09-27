import type { RecordItem } from "@/lib/fhir/normalize";

// On the unified timeline, a day's vital signs from one organization are one row: a single
// visit can record dozens (weight, pulse, blood pressure every few minutes), which would
// otherwise bury everything else. The Vitals page still lists each measurement.

export type TimelineEntry =
  | { kind: "record"; item: RecordItem }
  | { kind: "vitals"; key: string; day: string; source: string; sourceId?: string; items: RecordItem[] };

function dayOf(item: RecordItem): string | null {
  return item.category === "vital" && item.date && item.date.length >= 10 ? item.date.slice(0, 10) : null;
}

// Keeps the incoming (newest-first) order; a group sits where its first vital was.
export function groupVitals(items: RecordItem[]): TimelineEntry[] {
  const groups = new Map<string, RecordItem[]>();
  for (const item of items) {
    const day = dayOf(item);
    if (!day) continue;
    const key = `${item.sourceId ?? item.source}|${day}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const entries: TimelineEntry[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const day = dayOf(item);
    const key = day ? `${item.sourceId ?? item.source}|${day}` : null;
    const group = key ? groups.get(key) : undefined;
    if (!key || !day || !group || group.length < 2) {
      entries.push({ kind: "record", item });
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    entries.push({ kind: "vitals", key, day, source: item.source, sourceId: item.sourceId, items: group });
  }
  return entries;
}

// "Weight 68.5 kg · Temperature 37.2 °C · and 3 more": the day's distinct measurements, latest first.
export function vitalsSummary(items: RecordItem[], shown = 3): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const item of items) {
    if (seen.has(item.title)) continue;
    seen.add(item.title);
    parts.push(item.detail ? `${item.title} ${item.detail}` : item.title);
  }
  const more = parts.length - shown;
  return [...parts.slice(0, shown), ...(more > 0 ? [`and ${more} more`] : [])].join(" · ");
}
