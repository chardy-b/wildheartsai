import { and, eq, sql } from "drizzle-orm";
import { personaOrganizationName, personaSourceUrl, type Persona } from "@/lib/metriport/personas";
import { seal, unseal } from "../crypto/seal";
import { healthSource, metriportConnection } from "../db/schema";
import { auditStatement } from "./audit";
import type { UserScope } from "./scope";

// Metriport sandbox connections (src/lib/metriport/connections.ts in the Next app). The patient
// id is sealed with TOKEN_ENCRYPTION_KEY, like an Epic connection's.

export type MetriportConnectionSecrets = { id: string; sourceId: string; organizationName: string; persona: string | null; patientId: string; facilityId: string };

function secretsOf(row: typeof metriportConnection.$inferSelect, key: Buffer, organizationName: string): MetriportConnectionSecrets {
  return { id: row.id, sourceId: row.sourceId, organizationName, persona: row.persona, patientId: unseal(row.sealedPatientId, key), facilityId: row.facilityId };
}

// The connection of one of the person's sandbox personas, if they've connected it before.
export async function findPersonaConnection(scope: UserScope, key: Buffer, persona: Persona): Promise<MetriportConnectionSecrets | undefined> {
  const [row] = await scope.select(metriportConnection, eq(metriportConnection.persona, persona.id)).limit(1);
  return row ? secretsOf(row, key, personaOrganizationName(persona)) : undefined;
}

// Upserts the sample health system (health_source) and its Metriport link together, in one batch
// (audit pattern U). Connecting a persona again reuses the same source and its records.
export async function saveMetriportConnection(scope: UserScope, key: Buffer, input: { persona: Persona; patientId: string; facilityId: string }, now: Date): Promise<{ sourceId: string }> {
  const organizationName = personaOrganizationName(input.persona);
  const fhirBaseUrl = personaSourceUrl(input.persona);
  const link = { sealedPatientId: seal(input.patientId, key), facilityId: input.facilityId, updatedAt: now };
  const sourceId = sql`(select ${healthSource.id} from ${healthSource} where ${healthSource.userId} = ${scope.userId} and ${healthSource.fhirBaseUrl} = ${fhirBaseUrl})`;
  const [existing] = await scope.selectFields(healthSource, { id: healthSource.id }, eq(healthSource.fhirBaseUrl, fhirBaseUrl)).limit(1);
  const [[source]] = await scope.batch([
    scope
      .insert(healthSource, { id: crypto.randomUUID(), userId: scope.userId, vendor: "metriport", fhirBaseUrl, organizationName, status: "connected", createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [healthSource.userId, healthSource.fhirBaseUrl], set: { organizationName, status: "connected", updatedAt: now } })
      .returning({ id: healthSource.id }),
    scope
      .insert(metriportConnection, { id: crypto.randomUUID(), userId: scope.userId, sourceId, persona: input.persona.id, createdAt: now, ...link })
      .onConflictDoUpdate({ target: [metriportConnection.userId, metriportConnection.persona], set: link }),
    auditStatement(scope, { sourceId, action: existing ? "reconnect" : "connect" }, now),
  ]);
  return { sourceId: source.id as string };
}

export async function getMetriportConnectionForSource(scope: UserScope, key: Buffer, sourceId: string): Promise<MetriportConnectionSecrets | undefined> {
  const [row] = await scope.select(metriportConnection, eq(metriportConnection.sourceId, sourceId)).limit(1);
  if (!row) return undefined;
  const [source] = await scope.selectFields(healthSource, { organizationName: healthSource.organizationName }, and(eq(healthSource.id, sourceId))).limit(1);
  return secretsOf(row, key, source?.organizationName ?? "");
}
