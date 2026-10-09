import "server-only";
import { userKeysFor } from "@/lib/crypto/user-keys";
import { db } from "@/lib/db";
import { asUser } from "@/lib/db/rls";
import { env } from "@/lib/env";
import { recordsKey } from "@/lib/records-keys";
import type { JobEnv } from "@/lib/sync/job";
import { tokenKey } from "@/lib/epic/server";
import { createMetriportClient, externalIdFor, findOrCreatePatient, type MetriportClient } from "./client";
import { findPersonaConnection, getMetriportConnectionForSource, saveMetriportConnection } from "./connections";
import { metriportJob, waitForRecords } from "./job";
import type { Persona } from "./personas";

// Whether the Metriport sandbox option is offered: it needs the app's API key.
export function metriportEnabled(): boolean {
  return Boolean(env().METRIPORT_API_KEY);
}

function client(): MetriportClient {
  const key = env().METRIPORT_API_KEY;
  if (!key) throw new Error("METRIPORT_API_KEY is not set");
  return createMetriportClient(key);
}

// Save the connection first. The queued sync starts the network pull on both connect and refresh.
export async function connectSandboxPersona(userId: string, persona: Persona): Promise<{ sourceId: string }> {
  const metriport = client();
  const key = tokenKey();
  const existing = await asUser(db, userId, (tx) => findPersonaConnection(tx, key, userId, persona));
  const facilityId = existing?.facilityId ?? (await metriport.facilityId());
  const patientId = existing?.patientId ?? (await findOrCreatePatient(metriport, persona, facilityId, externalIdFor(userId, persona))).id;
  return asUser(db, userId, (tx) => saveMetriportConnection(tx, key, { userId, persona, patientId, facilityId }, new Date()));
}

export const loadMetriportSyncJob: JobEnv["load"] = async ({ runId, userId, sourceId }) => {
  const connection = await getMetriportConnectionForSource(db, tokenKey(), userId, sourceId);
  if (!connection) return undefined;
  const keys = await userKeysFor(db, recordsKey(), userId, new Date());
  return metriportJob({ db, keys, now: () => new Date() }, client(), runId, userId, connection);
};

export async function prepareMetriportSource(userId: string, sourceId: string): Promise<void> {
  const connection = await getMetriportConnectionForSource(db, tokenKey(), userId, sourceId);
  if (connection) await waitForRecords(client(), connection.patientId);
}

export async function startMetriportSource(userId: string, sourceId: string): Promise<void> {
  const connection = await getMetriportConnectionForSource(db, tokenKey(), userId, sourceId);
  if (connection) await client().startDocumentQuery(connection.patientId, connection.facilityId);
}
