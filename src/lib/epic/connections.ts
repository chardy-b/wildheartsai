import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { seal, unseal } from "@/lib/crypto/seal";
import { epicConnection, healthSource } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { InitialTokenSet, TokenSet } from "./tokens";

export type ConnectionSummary = {
  id: string;
  organizationName: string;
  fhirBaseUrl: string;
  scope: string;
  connectedAt: Date;
};

export type ConnectionSecrets = ConnectionSummary & {
  tokenEndpoint: string;
  patientId: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
};

function connectionSecretsOf(row: typeof epicConnection.$inferSelect, key: Buffer): ConnectionSecrets {
  return {
    id: row.id,
    organizationName: row.organizationName,
    fhirBaseUrl: row.fhirBaseUrl,
    scope: row.scope,
    connectedAt: row.createdAt,
    tokenEndpoint: row.tokenEndpoint,
    patientId: unseal(row.sealedPatientId, key),
    accessToken: unseal(row.sealedAccessToken, key),
    refreshToken: row.sealedRefreshToken ? unseal(row.sealedRefreshToken, key) : null,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
  };
}

// Upserts the organization (health_source) and its tokens together. Reconnecting an
// organization, including after a disconnect, reuses the same source and its records.
export async function saveConnection(
  db: Db,
  key: Buffer,
  input: { userId: string; fhirBaseUrl: string; organizationName: string; tokenEndpoint: string; tokens: InitialTokenSet },
  now: Date,
): Promise<{ sourceId: string }> {
  const secrets = {
    organizationName: input.organizationName,
    tokenEndpoint: input.tokenEndpoint,
    sealedPatientId: seal(input.tokens.patientId, key),
    sealedAccessToken: seal(input.tokens.accessToken, key),
    sealedRefreshToken: input.tokens.refreshToken ? seal(input.tokens.refreshToken, key) : null,
    accessTokenExpiresAt: input.tokens.expiresAt,
    scope: input.tokens.scope,
    updatedAt: now,
  };
  return db.transaction(async (tx) => {
    const [source] = await tx
      .insert(healthSource)
      .values({
        userId: input.userId,
        vendor: "epic",
        fhirBaseUrl: input.fhirBaseUrl,
        organizationName: input.organizationName,
        status: "connected",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [healthSource.userId, healthSource.fhirBaseUrl],
        set: { organizationName: input.organizationName, status: "connected", updatedAt: now },
      })
      .returning({ id: healthSource.id });
    await tx
      .insert(epicConnection)
      .values({ id: randomUUID(), userId: input.userId, sourceId: source.id, fhirBaseUrl: input.fhirBaseUrl, createdAt: now, ...secrets })
      .onConflictDoUpdate({ target: [epicConnection.userId, epicConnection.fhirBaseUrl], set: secrets });
    return { sourceId: source.id };
  });
}

export async function listConnections(db: Db, userId: string): Promise<ConnectionSummary[]> {
  const rows = await db
    .select({
      id: epicConnection.id,
      organizationName: epicConnection.organizationName,
      fhirBaseUrl: epicConnection.fhirBaseUrl,
      scope: epicConnection.scope,
      connectedAt: epicConnection.createdAt,
    })
    .from(epicConnection)
    .where(eq(epicConnection.userId, userId))
    .orderBy(asc(epicConnection.createdAt));
  return rows;
}

export async function getConnectionSecrets(db: Db, key: Buffer, userId: string): Promise<ConnectionSecrets[]> {
  const rows = await db
    .select()
    .from(epicConnection)
    .where(eq(epicConnection.userId, userId))
    .orderBy(asc(epicConnection.createdAt));
  return rows.map((row) => connectionSecretsOf(row, key));
}

// The connection holding a source's tokens, or undefined once it's been disconnected.
export async function getConnectionForSource(db: Db, key: Buffer, userId: string, sourceId: string): Promise<ConnectionSecrets | undefined> {
  const [row] = await db
    .select()
    .from(epicConnection)
    .where(and(eq(epicConnection.sourceId, sourceId), eq(epicConnection.userId, userId)))
    .limit(1);
  return row ? connectionSecretsOf(row, key) : undefined;
}

// Call only inside a transaction. The row lock serializes rotating refresh tokens
// across concurrent requests and server instances.
export async function getConnectionSecretForUpdate(db: Db, key: Buffer, id: string): Promise<ConnectionSecrets | undefined> {
  const [row] = await db.select().from(epicConnection).where(eq(epicConnection.id, id)).limit(1).for("update");
  return row ? connectionSecretsOf(row, key) : undefined;
}

export async function updateTokens(db: Db, key: Buffer, id: string, tokens: TokenSet, now: Date): Promise<void> {
  await db
    .update(epicConnection)
    .set({
      sealedAccessToken: seal(tokens.accessToken, key),
      ...(tokens.refreshToken ? { sealedRefreshToken: seal(tokens.refreshToken, key) } : {}),
      accessTokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope,
      updatedAt: now,
    })
    .where(eq(epicConnection.id, id));
}

// Deletes the tokens. The organization and its stored records stay, marked disconnected,
// until the person deletes them.
export async function deleteConnection(db: Db, userId: string, id: string, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(epicConnection)
      .where(and(eq(epicConnection.id, id), eq(epicConnection.userId, userId)))
      .returning({ sourceId: epicConnection.sourceId });
    if (deleted.length === 0) return false;
    await tx
      .update(healthSource)
      .set({ status: "disconnected", updatedAt: now })
      .where(and(eq(healthSource.id, deleted[0].sourceId), eq(healthSource.userId, userId)));
    return true;
  });
}
