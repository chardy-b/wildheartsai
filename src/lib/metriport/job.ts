import "server-only";
import { REFERENCED_TYPES } from "@/lib/fhir/references";
import type { Resource } from "@/lib/fhir/types";
import { SYNC_QUERIES } from "@/lib/sync/plan";
import type { SyncDeps, SyncSource } from "@/lib/sync/run";
import { MetriportError, queryState, type FhirBundle, type MetriportClient } from "./client";
import type { MetriportConnectionSecrets } from "./connections";
import { readFromBundle, searchBundle } from "./search";

// Plugs Metriport into the sync job (src/lib/sync/job.ts) as a SyncDeps whose "FHIR server" is the
// patient's consolidated bundle. The bundle is fetched once and shared by the job's steps that
// run close together; each step is otherwise independent and refetches.

// Metriport's records carry no per-resource permissions, so the connection "grants" every type the
// sync reads. Not Binary: Metriport serves documents as files, not FHIR Binary resources, so note
// text isn't imported.
export const METRIPORT_SCOPE = [...new Set([...SYNC_QUERIES.map((q) => q.resourceType), ...REFERENCED_TYPES])].map((type) => `patient/${type}.rs`).join(" ");

const BUNDLE_TTL_MS = 60_000;
const MAX_CACHED_BUNDLES = 5;
const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 40_000;

type Cached = { at: number; bundle: Promise<FhirBundle>; expiry: ReturnType<typeof setTimeout> };
const bundles = new Map<string, Cached>();

// For tests.
export function clearBundleCache(): void {
  for (const cached of bundles.values()) clearTimeout(cached.expiry);
  bundles.clear();
}

function bundleFor(client: MetriportClient, cacheKey: string, patientId: string, now: number): Promise<FhirBundle> {
  const cached = bundles.get(cacheKey);
  if (cached && now - cached.at < BUNDLE_TTL_MS) return cached.bundle;
  if (cached) {
    clearTimeout(cached.expiry);
    bundles.delete(cacheKey);
  }
  if (bundles.size >= MAX_CACHED_BUNDLES) {
    const oldest = bundles.keys().next().value!;
    clearTimeout(bundles.get(oldest)!.expiry);
    bundles.delete(oldest);
  }
  const bundle = client.consolidated(patientId);
  const expiry = setTimeout(() => {
    if (bundles.get(cacheKey)?.bundle === bundle) bundles.delete(cacheKey);
  }, BUNDLE_TTL_MS);
  expiry.unref();
  bundles.set(cacheKey, { at: now, bundle, expiry });
  // A failed fetch must not be served again.
  bundle.catch(() => {
    clearTimeout(expiry);
    if (bundles.get(cacheKey)?.bundle === bundle) bundles.delete(cacheKey);
  });
  return bundle;
}

export function metriportJob(
  base: Pick<SyncDeps, "db" | "keys" | "now">,
  client: MetriportClient,
  runId: string,
  userId: string,
  connection: MetriportConnectionSecrets,
): { deps: SyncDeps; source: SyncSource } {
  const cacheKey = JSON.stringify([userId, connection.sourceId, runId]);
  const bundle = () => bundleFor(client, cacheKey, connection.patientId, base.now().getTime());
  return {
    source: {
      runId,
      userId,
      sourceId: connection.sourceId,
      organizationName: connection.organizationName,
      fhirBaseUrl: `metriport:sandbox/${connection.persona ?? "patient"}`,
      patientId: connection.patientId,
      scope: METRIPORT_SCOPE,
    },
    deps: {
      ...base,
      accessToken: async () => "metriport",
      search: async ({ path, resourceType }) => {
        const resources: Resource[] = searchBundle(await bundle(), path).filter((r) => r.resourceType === resourceType);
        return { resources, truncated: false };
      },
      read: async ({ path }) => {
        const found = readFromBundle(await bundle(), path);
        if (!found) throw new MetriportError(404, "not_in_bundle");
        return found;
      },
    },
  };
}

// Waits for the pull from the networks to finish, within one step. Throws while it's still going so
// the queue retries the step later; a failed pull throws too (and fails the run after the retries).
export async function waitForRecords(
  client: MetriportClient,
  patientId: string,
  options: { sleep?: (ms: number) => Promise<void>; pollForMs?: number } = {},
): Promise<void> {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = (options.pollForMs ?? POLL_FOR_MS) / POLL_EVERY_MS;
  for (let attempt = 0; attempt <= deadline; attempt++) {
    const state = queryState(await client.documentQueryStatus(patientId));
    if (state === "completed") return;
    if (state === "failed") throw new MetriportError(undefined, "query_failed");
    if (attempt < deadline) await sleep(POLL_EVERY_MS);
  }
  throw new MetriportError(undefined, "query_still_running");
}
