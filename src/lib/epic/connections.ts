import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
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
  // One batch: the source upsert and the tokens land together. The tokens row finds its
  // source by (user, organization), which the first statement just made sure exists.
  const [[source]] = await db.batch([
    db
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
      .returning({ id: healthSource.id }),
    db
      .insert(epicConnection)
      .values({
        id: randomUUID(),
        userId: input.userId,
        sourceId: sql`(select ${healthSource.id} from ${healthSource} where ${healthSource.userId} = ${input.userId} and ${healthSource.fhirBaseUrl} = ${input.fhirBaseUrl})`,
        fhirBaseUrl: input.fhirBaseUrl,
        createdAt: now,
        ...secrets,
      })
      .onConflictDoUpdate({ target: [epicConnection.userId, epicConnection.fhirBaseUrl], set: secrets }),
  ]);
  return { sourceId: source.id };
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

export async function getConnectionSecret(db: Db, key: Buffer, id: string): Promise<ConnectionSecrets | undefined> {
  const [row] = await db.select().from(epicConnection).where(eq(epicConnection.id, id)).limit(1);
  return row ? connectionSecretsOf(row, key) : undefined;
}

// D1 has no row locks. Refreshing a connection's tokens is serialized with a lease on its
// row instead: whoever sets it refreshes, everyone else waits for the new tokens. A lease
// left behind by a crashed request expires by itself. updateTokens releases it.
// Returns the lease's expiry when claimed, to release it with.
export async function claimRefreshLease(db: Db, id: string, now: Date, leaseMs: number): Promise<Date | undefined> {
  const until = new Date(now.getTime() + leaseMs);
  const claimed = await db
    .update(epicConnection)
    .set({ refreshLeaseUntil: until })
    .where(and(eq(epicConnection.id, id), or(isNull(epicConnection.refreshLeaseUntil), lte(epicConnection.refreshLeaseUntil, now))))
    .returning({ id: epicConnection.id });
  return claimed.length > 0 ? until : undefined;
}

// Ends this holder's lease only, never one claimed by someone else since.
export async function releaseRefreshLease(db: Db, id: string, lease: Date): Promise<void> {
  await db
    .update(epicConnection)
    .set({ refreshLeaseUntil: null })
    .where(and(eq(epicConnection.id, id), eq(epicConnection.refreshLeaseUntil, lease)));
}

export async function updateTokens(db: Db, key: Buffer, id: string, tokens: TokenSet, now: Date): Promise<void> {
  await db
    .update(epicConnection)
    .set({
      sealedAccessToken: seal(tokens.accessToken, key),
      ...(tokens.refreshToken ? { sealedRefreshToken: seal(tokens.refreshToken, key) } : {}),
      accessTokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope,
      refreshLeaseUntil: null,
      updatedAt: now,
    })
    .where(eq(epicConnection.id, id));
}

// Deletes the tokens. The organization and its stored records stay, marked disconnected,
// until the person deletes them.
export async function deleteConnection(db: Db, userId: string, id: string, now = new Date()): Promise<boolean> {
  const mine = and(eq(epicConnection.id, id), eq(epicConnection.userId, userId));
  // One batch: mark the source while its tokens row still names it, then delete the row.
  const [, deleted] = await db.batch([
    db
      .update(healthSource)
      .set({ status: "disconnected", updatedAt: now })
      .where(
        and(
          eq(healthSource.userId, userId),
          inArray(healthSource.id, db.select({ id: epicConnection.sourceId }).from(epicConnection).where(mine)),
        ),
      ),
    db.delete(epicConnection).where(mine).returning({ sourceId: epicConnection.sourceId }),
  ]);
  return deleted.length > 0;
}
