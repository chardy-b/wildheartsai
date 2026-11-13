import { eq, sql } from "drizzle-orm";
import type { ConnectionSecrets } from "@/lib/epic/connections";
import type { InitialTokenSet, TokenSet } from "@/lib/epic/tokens";
import { seal, unseal } from "../crypto/seal";
import { epicConnection, healthSource, metriportConnection } from "../db/schema";
import { auditFrom, auditStatement } from "./audit";
import type { UserScope } from "./scope";

// Epic connections (src/lib/epic/connections.ts in the Next app). Tokens and the patient id are
// sealed with TOKEN_ENCRYPTION_KEY in the same format, so rows copied from Neon open here.
// Transactions follow docs/superpowers/specs/2026-10-30-d1-transaction-audit.md.

export type { ConnectionSecrets };

function secretsOf(row: typeof epicConnection.$inferSelect, key: Buffer): ConnectionSecrets {
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

// The person's source at this address, as a subquery: rows written in the same batch as the
// source's upsert can point at it without reading its id first.
const sourceIdAt = (userId: string, fhirBaseUrl: string) =>
  sql`(select ${healthSource.id} from ${healthSource} where ${healthSource.userId} = ${userId} and ${healthSource.fhirBaseUrl} = ${fhirBaseUrl})`;

// Upserts the organization (health_source) and its tokens together. Reconnecting an
// organization, including after a disconnect, reuses the same source and its records.
// Audit pattern U: one read, then one atomic batch.
export async function saveConnection(
  scope: UserScope,
  key: Buffer,
  input: { fhirBaseUrl: string; organizationName: string; tokenEndpoint: string; tokens: InitialTokenSet },
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
  // Only decides the audit wording; two simultaneous connects may both say "connect".
  const [existing] = await scope.selectFields(healthSource, { id: healthSource.id }, eq(healthSource.fhirBaseUrl, input.fhirBaseUrl)).limit(1);
  const [[source]] = await scope.batch([
    scope
      .insert(healthSource, {
        id: crypto.randomUUID(),
        userId: scope.userId,
        vendor: "epic",
        fhirBaseUrl: input.fhirBaseUrl,
        organizationName: input.organizationName,
        status: "connected",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: [healthSource.userId, healthSource.fhirBaseUrl], set: { organizationName: input.organizationName, status: "connected", updatedAt: now } })
      .returning({ id: healthSource.id }),
    scope
      .insert(epicConnection, {
        id: crypto.randomUUID(),
        userId: scope.userId,
        sourceId: sourceIdAt(scope.userId, input.fhirBaseUrl),
        fhirBaseUrl: input.fhirBaseUrl,
        createdAt: now,
        ...secrets,
      })
      .onConflictDoUpdate({ target: [epicConnection.userId, epicConnection.fhirBaseUrl], set: secrets }),
    auditStatement(scope, { sourceId: sourceIdAt(scope.userId, input.fhirBaseUrl), action: existing ? "reconnect" : "connect" }, now),
  ]);
  return { sourceId: source.id as string };
}

export async function getConnectionForSource(scope: UserScope, key: Buffer, sourceId: string): Promise<ConnectionSecrets | undefined> {
  const [row] = await scope.select(epicConnection, eq(epicConnection.sourceId, sourceId)).limit(1);
  return row ? secretsOf(row, key) : undefined;
}

export async function getConnection(scope: UserScope, key: Buffer, id: string): Promise<ConnectionSecrets | undefined> {
  const [row] = await scope.select(epicConnection, eq(epicConnection.id, id)).limit(1);
  return row ? secretsOf(row, key) : undefined;
}

export function updateTokens(scope: UserScope, key: Buffer, id: string, tokens: TokenSet, now: Date) {
  return scope.update(
    epicConnection,
    {
      sealedAccessToken: seal(tokens.accessToken, key),
      ...(tokens.refreshToken ? { sealedRefreshToken: seal(tokens.refreshToken, key) } : {}),
      accessTokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope,
      updatedAt: now,
    },
    eq(epicConnection.id, id),
  );
}

// Deletes the tokens (Epic or Metriport). The organization and its stored records stay, marked
// disconnected, until the person deletes them. Audit pattern G: the guarded statements first,
// the delete last, in one batch.
export async function disconnect(scope: UserScope, connectionId: string, now: Date): Promise<boolean> {
  for (const table of [epicConnection, metriportConnection] as const) {
    const ofConnection = sql`(select ${table.sourceId} from ${table} where ${table.id} = ${connectionId} and ${table.userId} = ${scope.userId})`;
    const [, , deleted] = await scope.batch([
      scope.update(healthSource, { status: "disconnected", updatedAt: now }, eq(healthSource.id, ofConnection)),
      auditFrom(scope, table, eq(table.id, connectionId), { action: "disconnect", sourceId: table.sourceId }, now),
      scope.delete(table, eq(table.id, connectionId)).returning({ id: table.id }),
    ]);
    if (deleted.length > 0) return true;
  }
  return false;
}
