import type { RecordItem } from "@/lib/fhir/normalize";
import type { SourceSummary } from "@/lib/sources";
import { hasFilters, type TimelineFilters } from "@/lib/timeline";

// The records a person has selected with the timeline filters, as a FHIR R4 collection Bundle.
// Resources go out exactly as their health system sent them; earlier versions are left out.

export type ExportBundle = {
  resourceType: "Bundle";
  type: "collection";
  timestamp: string;
  total: number;
  entry: { fullUrl?: string; resource: RecordItem["resource"] }[];
};

export function exportBundle(items: RecordItem[], sources: SourceSummary[], now: Date): ExportBundle {
  const baseUrls = new Map(sources.map((s) => [s.id, s.fhirBaseUrl.replace(/\/+$/, "")]));
  return {
    resourceType: "Bundle",
    type: "collection",
    timestamp: now.toISOString(),
    total: items.length,
    entry: items.map(({ resource, sourceId }) => {
      const base = sourceId ? baseUrls.get(sourceId) : undefined;
      return base && resource.id ? { fullUrl: `${base}/${resource.resourceType}/${resource.id}`, resource } : { resource };
    }),
  };
}

// e.g. wild-hearts-records-2026-09-27.json, or …-filtered-… when filters narrowed the selection.
export function exportFilename(filters: TimelineFilters, now: Date): string {
  return `wild-hearts-records-${hasFilters(filters) ? "filtered-" : ""}${now.toISOString().slice(0, 10)}.json`;
}
