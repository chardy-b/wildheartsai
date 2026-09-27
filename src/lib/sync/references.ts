import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { fhirResource, type SyncQueryStats } from "@/lib/db/schema";
import { grantsResource } from "@/lib/epic/authorize";
import { ReconnectRequiredError } from "@/lib/epic/errors";
import { collectReferences, normalizeReferenced, REFERENCED_TYPES, referenceKey, type ReferencedType } from "@/lib/fhir/references";
import type { Resource } from "@/lib/fhir/types";
import type { SyncDeps, SyncSource } from "./run";
import { FULL_PULL_EVERY_MS } from "./plan";
import { applyDiff, openStoredRow, prepareFetched, readCursor, saveCursor } from "./store";

// Fetches the medications, clinicians, organizations and locations this source's records point
// to, once each, and stores them without a category. Only types the connection was granted.
// Like the searches, most passes only look at records first stored since the last pass; a full
// pass at least weekly also retries references that failed before (not found, refused).

// Referenced resources fetched per sync; the rest follow on later syncs.
export const REFERENCE_BATCH = 200;
const CONCURRENCY = 4;
export const REFERENCES_STATS_KEY = "Reference:linked";

export async function syncReferences(deps: SyncDeps, source: SyncSource): Promise<SyncQueryStats> {
  const now = deps.now();
  const cursor = await readCursor(deps.db, source.sourceId, REFERENCES_STATS_KEY);
  const full = !cursor?.lastSuccessAt || !cursor.lastFullAt || now.getTime() - cursor.lastFullAt.getTime() >= FULL_PULL_EVERY_MS;
  const records = await deps.db
    .select({ id: fhirResource.id, sealedResource: fhirResource.sealedResource, sealedSummary: fhirResource.sealedSummary })
    .from(fhirResource)
    .where(
      and(
        eq(fhirResource.sourceId, source.sourceId),
        isNotNull(fhirResource.category),
        isNull(fhirResource.supersededAt),
        isNull(fhirResource.removedAt),
        full ? undefined : gt(fhirResource.firstSeenAt, cursor!.lastSuccessAt!),
      ),
    );
  const stored = new Set(
    (
      await deps.db
        .select({ resourceType: fhirResource.resourceType, fhirId: fhirResource.fhirId })
        .from(fhirResource)
        .where(
          and(
            eq(fhirResource.sourceId, source.sourceId),
            isNull(fhirResource.category),
            isNull(fhirResource.supersededAt),
            inArray(fhirResource.resourceType, [...REFERENCED_TYPES]),
          ),
        )
    ).map((r) => `${r.resourceType}/${r.fhirId}`),
  );

  const wanted = new Set<string>();
  for (const row of records) for (const key of collectReferences(openStoredRow(deps.keys, row).resource)) wanted.add(key);
  const pending = [...wanted].filter((key) => !stored.has(key) && grantsResource(source.scope, key.split("/")[0]));
  const batch = pending.slice(0, REFERENCE_BATCH);

  const fetched = new Map<ReferencedType, Resource[]>();
  let failed = 0;
  if (batch.length) {
    const accessToken = await deps.accessToken();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
        while (next < batch.length) {
          const key = batch[next++];
          const ref = referenceKey(key)!;
          try {
            const resource = (await deps.read({ baseUrl: source.fhirBaseUrl, path: key, accessToken })) as Resource;
            // Only what was asked for: the right type, and the id as requested.
            if (resource?.resourceType !== ref.type || resource.id !== ref.id) {
              failed++;
              continue;
            }
            fetched.set(ref.type, [...(fetched.get(ref.type) ?? []), resource]);
          } catch (error) {
            if (error instanceof ReconnectRequiredError) throw error;
            failed++;
          }
        }
      }),
    );
  }

  let inserted = 0;
  for (const [type, resources] of fetched) {
    const query = { key: `Reference:${type}`, category: null, resourceType: type, path: () => type, normalize: normalizeReferenced };
    const counts = await applyDiff(
      deps.db,
      deps.keys,
      { userId: source.userId, sourceId: source.sourceId, organizationName: source.organizationName, query },
      { insert: prepareFetched(deps.keys, resources), supersede: [], unchanged: [], restore: [], remove: [] },
      now,
    );
    inserted += counts.inserted;
  }
  // Left for later only when there were more than one pass fetches: the next pass picks them up.
  if (pending.length <= batch.length) {
    await saveCursor(deps.db, source.sourceId, REFERENCES_STATS_KEY, { lastSuccessAt: now, ...(full ? { lastFullAt: now } : {}) });
  }
  if (failed) console.error(`[sync] ${REFERENCES_STATS_KEY} ${failed} failed`);

  return {
    fetched: batch.length,
    inserted,
    superseded: 0,
    unchanged: wanted.size - pending.length,
    removed: 0,
    // Best-effort detail: records show fine without it, and failures are retried on the next full pass.
    optional: true,
    ...(failed ? { errorCode: "references_failed" } : pending.length > batch.length ? { errorCode: "truncated" } : {}),
  };
}
