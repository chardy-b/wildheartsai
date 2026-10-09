import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { asUser, RLS_TABLES } from "./rls";
import { auditEvent, fhirResource, healthSource, metriportConnection, syncCursor } from "./schema";
import type { Db } from "./types";

let db: Db;
let alice: string;
let bob: string;
let bobSource: string;

// The test database runs as a superuser, which RLS never applies to. Production connects as the
// tables' owner, which FORCE covers; here an ordinary role stands in for it.
async function asAppRole<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role rls_app`);
    return work(tx as unknown as Db);
  });
}

beforeAll(async () => {
  db = await createTestDb();
  await db.execute(sql`create role rls_app nologin`);
  await db.execute(sql`grant all on all tables in schema public to rls_app`);
  alice = await createTestUser(db, "rls_alice");
  bob = await createTestUser(db, "rls_bob");
  const [a, b] = await db
    .insert(healthSource)
    .values([
      { userId: alice, vendor: "epic", fhirBaseUrl: "https://a.example/R4", organizationName: "A", status: "connected" },
      { userId: bob, vendor: "epic", fhirBaseUrl: "https://b.example/R4", organizationName: "B", status: "connected" },
    ])
    .returning({ id: healthSource.id });
  bobSource = b.id;
  const now = new Date();
  for (const [userId, sourceId] of [[alice, a.id], [bob, b.id]]) {
    await db.insert(metriportConnection).values({ id: `mp-${userId}`, userId, sourceId, persona: "jane", sealedPatientId: "sealed-test-id", facilityId: "sandbox-facility" });
    await db.insert(fhirResource).values({
      userId, sourceId, resourceType: "Observation", fhirId: "o1", category: "lab", contentHmac: "h",
      sealedResource: "v2.x", sealedSummary: "v2.y", normalizerVersion: 2, firstSeenAt: now, lastSeenAt: now,
    });
    await db.insert(syncCursor).values({ sourceId, queryKey: "Observation:lab", lastSuccessAt: now });
  }
});

describe("row-level security", () => {
  it("covers every table holding a person's data, including for the tables' owner", async () => {
    const result = (await db.execute(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ${[...RLS_TABLES]}`,
    )) as unknown as { rows: { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[] };
    const tables = result.rows;
    expect(tables).toHaveLength(RLS_TABLES.length);
    for (const t of tables) expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("shows only the signed-in person's rows", async () => {
    const seen = await asAppRole((tx) => asUser(tx, alice, async (u) => ({
      sources: await u.select({ userId: healthSource.userId }).from(healthSource),
      records: await u.select({ userId: fhirResource.userId }).from(fhirResource),
      cursors: await u.select({ sourceId: syncCursor.sourceId }).from(syncCursor),
      metriport: await u.select({ userId: metriportConnection.userId }).from(metriportConnection),
    })));
    expect(seen.sources).toEqual([{ userId: alice }]);
    expect(seen.records).toEqual([{ userId: alice }]);
    expect(seen.metriport).toEqual([{ userId: alice }]);
    expect(seen.cursors).toHaveLength(1);
    expect(seen.cursors[0].sourceId).not.toBe(bobSource);
  });

  it("can't change or delete someone else's rows, even when a query forgets to check the owner", async () => {
    await asAppRole((tx) =>
      asUser(tx, alice, async (u) => {
        await u.update(healthSource).set({ organizationName: "changed" }).where(eq(healthSource.id, bobSource));
        await u.delete(fhirResource).where(eq(fhirResource.sourceId, bobSource));
        await u.delete(metriportConnection).where(eq(metriportConnection.sourceId, bobSource));
      }),
    );
    const [source] = await db.select().from(healthSource).where(eq(healthSource.id, bobSource));
    expect(source.organizationName).toBe("B");
    expect(await db.select().from(fhirResource).where(eq(fhirResource.userId, bob))).toHaveLength(1);
    expect(await db.select().from(metriportConnection).where(eq(metriportConnection.userId, bob))).toHaveLength(1);
  });

  it("refuses to write a row for someone else", async () => {
    await expect(
      asAppRole((tx) => asUser(tx, alice, (u) => u.insert(auditEvent).values({ userId: bob, action: "export" }))),
    ).rejects.toThrow();
  });

  it("leaves queries without a user as they were, until every caller sets one", async () => {
    const all = await asAppRole((tx) => tx.select({ userId: healthSource.userId }).from(healthSource));
    expect(all.map((r) => r.userId).sort()).toEqual([alice, bob].sort());
  });

  it("forgets the user when the transaction ends, so a pooled connection can't carry it over", async () => {
    await asAppRole((tx) => asUser(tx, alice, async () => undefined));
    const next = await asAppRole((tx) => tx.select({ userId: healthSource.userId }).from(healthSource));
    expect(next).toHaveLength(2);
  });
});
