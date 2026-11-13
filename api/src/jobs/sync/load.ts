import { eq } from "drizzle-orm";
import { fhirRead, fhirSearchBounded } from "@/lib/fhir/client";
import { createMetriportClient, type MetriportClient } from "@/lib/metriport/client";
import { getConnectionForSource } from "../../data/connections";
import { getMetriportConnectionForSource } from "../../data/metriport";
import type { UserScope } from "../../data/scope";
import { userKeysFor } from "../../data/user-keys";
import { healthSource } from "../../db/schema";
import { secrets, type Bindings } from "../../env";
import { recordsKey, tokenKey } from "../../epic/credentials";
import { accessTokenFor } from "../../epic/token-refresher";
import type { JobEnv } from "./job";
import { metriportJob, waitForRecords } from "./metriport";

// What each sync step loads afresh (src/lib/sync/server.ts in the Next app): the source's
// connection and the owner's keys, in the owner's scope. Secrets stay in memory.

export function metriportClient(env: Bindings): MetriportClient {
  const key = secrets(env).METRIPORT_API_KEY;
  if (!key) throw new Error("METRIPORT_API_KEY is not set");
  return createMetriportClient(key);
}

export function syncJobEnv(env: Bindings, scope: UserScope, client: () => MetriportClient = () => metriportClient(env)): JobEnv {
  const config = secrets(env);
  const now = () => new Date();
  const vendorOf = async (sourceId: string) => (await scope.selectFields(healthSource, { vendor: healthSource.vendor }, eq(healthSource.id, sourceId)).limit(1))[0]?.vendor;
  const metriportConnection = (sourceId: string) => getMetriportConnectionForSource(scope, tokenKey(config), sourceId);

  return {
    scope,
    now,
    load: async ({ runId, sourceId }) => {
      if ((await vendorOf(sourceId)) === "metriport") {
        const connection = await metriportConnection(sourceId);
        if (!connection) return undefined;
        const keys = await userKeysFor(scope, recordsKey(config), now());
        return metriportJob({ scope, keys, now }, client(), runId, connection);
      }
      const connection = await getConnectionForSource(scope, tokenKey(config), sourceId);
      if (!connection) return undefined;
      const keys = await userKeysFor(scope, recordsKey(config), now());
      return {
        source: { runId, userId: scope.userId, sourceId, organizationName: connection.organizationName, fhirBaseUrl: connection.fhirBaseUrl, patientId: connection.patientId, scope: connection.scope },
        deps: {
          scope,
          keys,
          now,
          accessToken: () => accessTokenFor(env, scope.userId, connection),
          search: (input) => fhirSearchBounded(input),
          read: (input) => fhirRead(input),
        },
      };
    },
    // Metriport sources start the pull from the networks, then wait for it, before the searches.
    start: async ({ sourceId }) => {
      if ((await vendorOf(sourceId)) !== "metriport") return;
      const connection = await metriportConnection(sourceId);
      if (connection) await client().startDocumentQuery(connection.patientId, connection.facilityId);
    },
    prepare: async ({ sourceId }) => {
      if ((await vendorOf(sourceId)) !== "metriport") return;
      const connection = await metriportConnection(sourceId);
      if (connection) await waitForRecords(client(), connection.patientId);
    },
  };
}
