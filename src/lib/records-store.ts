import { and, eq, isNull } from "drizzle-orm";
import type { UserKeys } from "@/lib/crypto/user-keys";
import { fhirResource } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { RecordCategory, RecordItem } from "@/lib/fhir/normalize";
import { newestFirst, type RecordProblem, type RecordsResult } from "@/lib/records";
import type { SourceSummary } from "@/lib/sources";
import { SYNC_QUERIES } from "@/lib/sync/plan";
import { openStoredRow } from "@/lib/sync/store";

// Reads the person's stored records, from every source including disconnected ones.

// What the person should know about each source, from its status and last sync.
export function sourceProblems(sources: SourceSummary[]): RecordProblem[] {
  const problems: RecordProblem[] = [];
  for (const source of sources) {
    const organizationName = source.organizationName;
    if (source.syncing) problems.push({ organizationName, kind: "importing" });
    if (source.status === "reconnect_required") {
      problems.push({ organizationName, kind: "reconnect" });
      continue;
    }
    if (source.status === "disconnected" || source.syncing || !source.lastRunStats) continue;
    const stats = Object.entries(source.lastRunStats);
    const truncated = stats
      .filter(([, s]) => s.errorCode === "truncated")
      .map(([key]) => SYNC_QUERIES.find((q) => q.key === key)?.category)
      .filter((c): c is RecordCategory => c !== undefined);
    if (stats.some(([, s]) => s.errorCode && s.errorCode !== "truncated")) problems.push({ organizationName, kind: "unavailable" });
    if (truncated.length) problems.push({ organizationName, kind: "partial", categories: truncated });
  }
  return problems;
}

export async function loadStoredRecords(db: Db, keys: UserKeys, userId: string, sources: SourceSummary[]): Promise<RecordsResult> {
  const rows = await db
    .select({
      id: fhirResource.id,
      sourceId: fhirResource.sourceId,
      sealedResource: fhirResource.sealedResource,
      sealedSummary: fhirResource.sealedSummary,
    })
    .from(fhirResource)
    .where(and(eq(fhirResource.userId, userId), isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt)));

  const bySource = new Map(sources.map((s) => [s.id, s]));
  const items = rows.flatMap((row): RecordItem[] => {
    const source = bySource.get(row.sourceId);
    if (!source) return [];
    const { resource, summary } = openStoredRow(keys, row);
    // The organization's current name, and its live connection (if any) for loading a note's text.
    return [{ ...summary, source: source.organizationName, resource, connectionId: source.connectionId ?? "" }];
  });
  items.sort(newestFirst);
  return { items, problems: sourceProblems(sources) };
}
