import type { SyncQueryStats } from "@/lib/db/schema";
import { CATEGORIES } from "@/lib/fhir/categories";
import type { RecordCategory } from "@/lib/fhir/normalize";
import { SYNC_QUERIES } from "@/lib/sync/plan";

// How a source's state reads to the person. Pure, so pages and tests share it.

export function ago(date: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Non-zero categories in dashboard order.
export function categoryCounts(counts: Partial<Record<string, number>>): { category: RecordCategory; label: string; count: number }[] {
  return CATEGORIES.flatMap(({ category, label }) => {
    const count = counts[category] ?? 0;
    return count > 0 ? [{ category, label, count }] : [];
  });
}

// What the last finished sync couldn't load: categories whose search failed, and
// categories with more records than one sync imports.
export function lastRunIssues(stats: Record<string, SyncQueryStats> | null): { failed: RecordCategory[]; truncated: RecordCategory[] } {
  const failed: RecordCategory[] = [];
  const truncated: RecordCategory[] = [];
  for (const [key, s] of Object.entries(stats ?? {})) {
    const category = SYNC_QUERIES.find((q) => q.key === key)?.category;
    if (!category || !s.errorCode) continue;
    (s.errorCode === "truncated" ? truncated : failed).push(category);
  }
  return { failed, truncated };
}

export function listOf(words: string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
