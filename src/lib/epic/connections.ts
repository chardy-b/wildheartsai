import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { seal, unseal } from "@/lib/crypto/seal";
import { epicConnection } from "@/lib/db/schema";
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

export async function saveConnection(
  db: Db,
  key: Buffer,
  input: { userId: string; fhirBaseUrl: string; organizationName: string; tokenEndpoint: string; tokens: InitialTokenSet },
  now: Date,
): Promise<void> {
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
  await db
    .insert(epicConnection)
    .values({ id: randomUUID(), userId: input.userId, fhirBaseUrl: input.fhirBaseUrl, createdAt: now, ...secrets })
    .onConflictDoUpdate({ target: [epicConnection.userId, epicConnection.fhirBaseUrl], set: secrets });
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
  return rows.map((row) => ({
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
  }));
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

export async function deleteConnection(db: Db, userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(epicConnection)
    .where(and(eq(epicConnection.id, id), eq(epicConnection.userId, userId)))
    .returning({ id: epicConnection.id });
  return deleted.length > 0;
}
