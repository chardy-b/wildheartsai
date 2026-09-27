import type { NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { exportBundle, exportFilename } from "@/lib/export";
import { requireOnboarded } from "@/lib/onboarding-guard";
import { loadExportFor, loadSourcesFor } from "@/lib/records-server";
import { parseFilters } from "@/lib/timeline";

// Downloads the records the timeline filters select (same query string as /app), as a FHIR Bundle.
export async function GET(request: NextRequest) {
  const { session } = await requireOnboarded();
  const userId = session.user.id;
  const search = request.nextUrl.searchParams;
  const params = Object.fromEntries([...new Set(search.keys())].map((key) => [key, search.getAll(key)]));
  const filters = parseFilters(params, await loadSourcesFor(userId));
  const { sources, items } = await loadExportFor(userId, filters);
  const now = new Date();
  const filtered = filters.sourceIds.length > 0 || filters.categories.length > 0 || filters.from !== null || filters.to !== null;
  await recordAudit(db, { userId, action: "export", detail: { records: items.length, filtered } }, now);
  return new Response(JSON.stringify(exportBundle(items, sources, now), null, 2), {
    headers: {
      "Content-Type": "application/fhir+json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(filters, now)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
