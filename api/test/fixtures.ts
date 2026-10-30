import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "../src/db";
import * as s from "../src/db/schema";

// Made-up rows for one person in every table that holds a person's data, in dependency order.
// `touch` is a harmless change used to check that updates stay within the owner's rows.
export type OwnedRow = { key: string; table: SQLiteTable; row: Record<string, unknown>; touch: Record<string, unknown> };

export function ownedRows(userId: string): OwnedRow[] {
  const at = new Date("2026-10-30T12:00:00.000Z");
  const source = `${userId}-source`;
  const source2 = `${userId}-source-2`;
  const file = `${userId}-file`;
  const run = `${userId}-extraction`;
  const resource = `${userId}-resource`;
  return [
    { key: "userDataKey", table: s.userDataKey, row: { userId, sealedDek: "sealed", kekVersion: 1 }, touch: { kekVersion: 2 } },
    { key: "healthSource", table: s.healthSource, row: { id: source, userId, vendor: "epic", fhirBaseUrl: "https://fhir.example.test/a/", organizationName: "Example Health", status: "connected" }, touch: { status: "disconnected" } },
    { key: "healthSource", table: s.healthSource, row: { id: source2, userId, vendor: "metriport", fhirBaseUrl: "https://fhir.example.test/b/", organizationName: "Example HIE", status: "connected" }, touch: { status: "disconnected" } },
    { key: "epicConnection", table: s.epicConnection, row: { id: `${userId}-epic`, userId, sourceId: source, fhirBaseUrl: "https://fhir.example.test/a/", organizationName: "Example Health", tokenEndpoint: "https://fhir.example.test/token", sealedPatientId: "sealed", sealedAccessToken: "sealed", accessTokenExpiresAt: at, scope: "openid" }, touch: { scope: "openid fhirUser" } },
    { key: "metriportConnection", table: s.metriportConnection, row: { id: `${userId}-metriport`, userId, sourceId: source2, persona: "jane", sealedPatientId: "sealed", facilityId: "facility" }, touch: { facilityId: "facility-2" } },
    { key: "fhirResource", table: s.fhirResource, row: { id: resource, userId, sourceId: source, resourceType: "Observation", fhirId: "obs-1", contentHmac: "hmac", sealedResource: "sealed", sealedSummary: "sealed", normalizerVersion: 1, firstSeenAt: at, lastSeenAt: at }, touch: { category: "laboratory" } },
    { key: "fhirAttachment", table: s.fhirAttachment, row: { id: `${userId}-attachment`, userId, sourceId: source, resourceId: resource, sealedUrl: "sealed", urlHmac: "hmac", fetchedAt: at }, touch: { contentType: "text/plain" } },
    { key: "syncRun", table: s.syncRun, row: { id: `${userId}-sync`, userId, sourceId: source, trigger: "manual", status: "ok" }, touch: { status: "failed" } },
    { key: "syncCursor", table: s.syncCursor, row: { sourceId: source, queryKey: "Observation:laboratory" }, touch: { lastFullAt: at } },
    { key: "auditEvent", table: s.auditEvent, row: { id: `${userId}-audit`, userId, sourceId: source, action: "connect" }, touch: { action: "sync" } },
    { key: "profile", table: s.profile, row: { userId, preferredName: "Sam" }, touch: { preferredName: "Sam R." } },
    { key: "wildcardFile", table: s.wildcardFile, row: { id: file, userId, sealedMetadata: "sealed", objectKey: `${userId}-object`, sizeBytes: 12 }, touch: { status: "ready" } },
    { key: "extractionRun", table: s.extractionRun, row: { id: run, userId, fileId: file, method: "native", sealedConfig: "sealed" }, touch: { resultDigest: "digest" } },
    { key: "extractionJob", table: s.extractionJob, row: { id: run, userId, sessionId: "session" }, touch: { status: "cancelled" } },
    { key: "extractionReference", table: s.extractionReference, row: { id: `${userId}-reference`, userId, fileId: file, sealedLabels: "sealed" }, touch: { sealedLabels: "sealed-2" } },
  ];
}

// Writes a person and all their rows directly (test setup, outside the data layer).
export async function seedPerson(db: Db, userId: string): Promise<void> {
  await db.insert(s.user).values({ id: userId, name: userId, email: `${userId}@example.test`, emailVerified: true, updatedAt: new Date() });
  for (const { table, row } of ownedRows(userId)) await db.insert(table).values(row as never);
}

// Removes everyone (rows cascade from user) and the audit trail, which has no foreign key.
export async function clearPeople(db: Db): Promise<void> {
  await db.delete(s.user);
  await db.delete(s.auditEvent);
}
