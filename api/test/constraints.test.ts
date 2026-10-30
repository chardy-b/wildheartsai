import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import * as s from "../src/db/schema";
import { clearPeople, seedPerson } from "./fixtures";

// Constraints the app relies on, checked on D1 itself rather than assumed from Postgres.
const db = database(env.DB);
const A = "person-a";
const at = new Date("2026-10-30T12:00:00.000Z");

beforeEach(async () => {
  await clearPeople(db);
  await seedPerson(db, A);
});

const version = (id: string, extra: Record<string, unknown> = {}) => ({
  id, userId: A, sourceId: `${A}-source`, resourceType: "Observation", fhirId: "obs-1", contentHmac: "h",
  sealedResource: "sealed", sealedSummary: "sealed", normalizerVersion: 1, firstSeenAt: at, lastSeenAt: at, ...extra,
});

describe("D1 constraints", () => {
  it("enforces foreign keys", async () => {
    await expect(db.insert(s.healthSource).values({ userId: "nobody", vendor: "epic", fhirBaseUrl: "https://x.test/", organizationName: "X", status: "connected" })).rejects.toThrow();
  });

  it("cascades a person's deletion to their rows", async () => {
    await db.delete(s.user).where(eq(s.user.id, A));
    expect(await db.select().from(s.fhirResource)).toEqual([]);
    expect(await db.select().from(s.syncCursor)).toEqual([]);
    // The audit trail outlives the account by design.
    expect(await db.select().from(s.auditEvent)).toHaveLength(1);
  });

  it("allows one current version of a resource, and keeps superseded ones", async () => {
    await expect(db.insert(s.fhirResource).values(version("dup"))).rejects.toThrow();
    await db.update(s.fhirResource).set({ supersededAt: at }).where(eq(s.fhirResource.id, `${A}-resource`));
    await db.insert(s.fhirResource).values(version("v2"));
    await db.update(s.fhirResource).set({ supersededBy: "v2" }).where(eq(s.fhirResource.id, `${A}-resource`));
    expect(await db.select().from(s.fhirResource)).toHaveLength(2);
  });

  it("allows one active sync run per source", async () => {
    const run = (id: string, status: "queued" | "running" | "ok") => ({ id, userId: A, sourceId: `${A}-source`, trigger: "manual" as const, status });
    await db.insert(s.syncRun).values(run("r1", "queued"));
    await expect(db.insert(s.syncRun).values(run("r2", "running"))).rejects.toThrow();
    await db.insert(s.syncRun).values(run("r3", "ok"));
  });

  it("round-trips timestamps, booleans and JSON", async () => {
    const [row] = await db.insert(s.syncRun).values({ id: "r9", userId: A, sourceId: `${A}-source-2`, trigger: "scheduled", status: "ok", stats: { "Observation:laboratory": { fetched: 3, inserted: 2, superseded: 0, unchanged: 1, removed: 0 } }, startedAt: at }).returning();
    expect(row.startedAt).toEqual(at);
    expect(row.queuedAt).toBeInstanceOf(Date);
    expect(row.stats["Observation:laboratory"].fetched).toBe(3);
    const [person] = await db.select().from(s.user).where(eq(s.user.id, A));
    expect(person.emailVerified).toBe(true);
  });

  it("fills database defaults for rows written by raw SQL", async () => {
    await env.DB.prepare("insert into audit_event (id, user_id, action) values ('raw', ?, 'sync')").bind(A).run();
    const [row] = await db.select().from(s.auditEvent).where(eq(s.auditEvent.id, "raw"));
    expect(row.detail).toEqual({});
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
  });
});
