import { MetriportError, queryState, type FhirBundle, type MetriportClient } from "@/lib/metriport/client";
import { METRIPORT_SCOPE } from "@/lib/metriport/scope";
import { readFromBundle, searchBundle } from "@/lib/metriport/search";
import type { Resource } from "@/lib/fhir/types";
import type { MetriportConnectionSecrets } from "../../data/metriport";
import type { SyncDeps, SyncSource } from "./run";

// Metriport in the sync job (src/lib/metriport/job.ts in the Next app): a SyncDeps whose "FHIR
// server" is the patient's consolidated bundle, fetched once and shared by steps that run close
// together. The Next app expired cached bundles with Node timers; here each read checks the age.

const BUNDLE_TTL_MS = 60_000;
const MAX_CACHED_BUNDLES = 5;
const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 40_000;

const bundles = new Map<string, { at: number; bundle: Promise<FhirBundle> }>();

// For tests.
export function clearBundleCache(): void {
  bundles.clear();
}

function bundleFor(client: MetriportClient, cacheKey: string, patientId: string, now: number): Promise<FhirBundle> {
  const cached = bundles.get(cacheKey);
  if (cached && now - cached.at < BUNDLE_TTL_MS) return cached.bundle;
  bundles.delete(cacheKey);
  for (const [key, entry] of bundles) if (now - entry.at >= BUNDLE_TTL_MS) bundles.delete(key);
  if (bundles.size >= MAX_CACHED_BUNDLES) bundles.delete(bundles.keys().next().value!);
  const bundle = client.consolidated(patientId);
  bundles.set(cacheKey, { at: now, bundle });
  // A failed fetch must not be served again.
  bundle.catch(() => {
    if (bundles.get(cacheKey)?.bundle === bundle) bundles.delete(cacheKey);
  });
  return bundle;
}

export function metriportJob(
  base: Pick<SyncDeps, "scope" | "keys" | "now">,
  client: MetriportClient,
  runId: string,
  connection: MetriportConnectionSecrets,
): { deps: SyncDeps; source: SyncSource } {
  const cacheKey = JSON.stringify([base.scope.userId, connection.sourceId, runId]);
  const bundle = () => bundleFor(client, cacheKey, connection.patientId, base.now().getTime());
  return {
    source: {
      runId,
      userId: base.scope.userId,
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

// Waits for the pull from the networks to finish, within one step. Throws while it's still going
// so the Workflow retries the step later; a failed pull throws too.
export async function waitForRecords(client: MetriportClient, patientId: string, options: { sleep?: (ms: number) => Promise<void>; pollForMs?: number } = {}): Promise<void> {
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
