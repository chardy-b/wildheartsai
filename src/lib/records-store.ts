import type { RecordProblem } from "@/lib/records";
import { lastRunIssues } from "@/lib/source-display";
import type { SourceSummary } from "@/lib/sources";

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
    const { failed, truncated } = lastRunIssues(source.lastRunStats);
    if (failed.length) problems.push({ organizationName, kind: "unavailable" });
    if (truncated.length) problems.push({ organizationName, kind: "partial", categories: truncated });
  }
  return problems;
}
