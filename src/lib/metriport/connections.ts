import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { seal, unseal } from "@/lib/crypto/seal";
import { healthSource, metriportConnection } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { personaOrganizationName, personaSourceUrl, type Persona } from "./personas";

export type MetriportConnectionSecrets = {
  id: string;
  sourceId: string;
  organizationName: string;
  persona: string | null;
  patientId: string;
  facilityId: string;
};

// The connection of one of the person's sandbox personas, if they've connected it before.
export async function findPersonaConnection(db: Db, key: Buffer, userId: string, persona: Persona): Promise<MetriportConnectionSecrets | undefined> {
  const [row] = await db
    .select()
    .from(metriportConnection)
    .where(and(eq(metriportConnection.userId, userId), eq(metriportConnection.persona, persona.id)))
    .limit(1);
  return row ? secretsOf(row, key, personaOrganizationName(persona)) : undefined;
}

function secretsOf(row: typeof metriportConnection.$inferSelect, key: Buffer, organizationName: string): MetriportConnectionSecrets {
  return {
    id: row.id,
    sourceId: row.sourceId,
    organizationName,
    persona: row.persona,
    patientId: unseal(row.sealedPatientId, key),
    facilityId: row.facilityId,
  };
}

// Upserts the sample health system (health_source) and its Metriport link together. Connecting a
// persona again reuses the same source and its records.
export async function saveMetriportConnection(
  db: Db,
  key: Buffer,
  input: { userId: string; persona: Persona; patientId: string; facilityId: string },
  now: Date,
): Promise<{ sourceId: string }> {
  const organizationName = personaOrganizationName(input.persona);
  const fhirBaseUrl = personaSourceUrl(input.persona);
  const link = { sealedPatientId: seal(input.patientId, key), facilityId: input.facilityId, updatedAt: now };
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: healthSource.id })
      .from(healthSource)
      .where(and(eq(healthSource.userId, input.userId), eq(healthSource.fhirBaseUrl, fhirBaseUrl)))
      .limit(1);
    const [source] = await tx
      .insert(healthSource)
      .values({ userId: input.userId, vendor: "metriport", fhirBaseUrl, organizationName, status: "connected", createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [healthSource.userId, healthSource.fhirBaseUrl],
        set: { organizationName, status: "connected", updatedAt: now },
      })
      .returning({ id: healthSource.id });
    await tx
      .insert(metriportConnection)
      .values({ id: randomUUID(), userId: input.userId, sourceId: source.id, persona: input.persona.id, createdAt: now, ...link })
      .onConflictDoUpdate({ target: [metriportConnection.userId, metriportConnection.persona], set: link });
    await recordAudit(tx, { userId: input.userId, sourceId: source.id, action: existing ? "reconnect" : "connect" }, now);
    return { sourceId: source.id };
  });
}

export async function getMetriportConnectionForSource(db: Db, key: Buffer, userId: string, sourceId: string): Promise<MetriportConnectionSecrets | undefined> {
  const [row] = await db
    .select({ connection: metriportConnection, organizationName: healthSource.organizationName })
    .from(metriportConnection)
    .innerJoin(healthSource, eq(healthSource.id, metriportConnection.sourceId))
    .where(and(eq(metriportConnection.sourceId, sourceId), eq(metriportConnection.userId, userId)))
    .limit(1);
  return row ? secretsOf(row.connection, key, row.organizationName) : undefined;
}

// Deletes the link. The sample health system and its stored records stay, marked disconnected,
// until the person deletes them (the same as disconnecting Epic).
export async function deleteMetriportConnection(db: Db, userId: string, id: string, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(metriportConnection)
      .where(and(eq(metriportConnection.id, id), eq(metriportConnection.userId, userId)))
      .returning({ sourceId: metriportConnection.sourceId });
    if (deleted.length === 0) return false;
    await tx
      .update(healthSource)
      .set({ status: "disconnected", updatedAt: now })
      .where(and(eq(healthSource.id, deleted[0].sourceId), eq(healthSource.userId, userId)));
    await recordAudit(tx, { userId, sourceId: deleted[0].sourceId, action: "disconnect" }, now);
    return true;
  });
}
