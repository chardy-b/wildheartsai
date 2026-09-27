import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { fhirResource, healthSource, syncRun, user, userDataKey } from "./schema";
import type { Db } from "./types";

const now = new Date("2026-09-26T10:00:00Z");
let db: Db;
let userId: string;

async function addSource(id = userId, url = "https://fhir.example.org/R4"): Promise<string> {
  const [row] = await db
    .insert(healthSource)
    .values({ userId: id, vendor: "epic", fhirBaseUrl: url, organizationName: "Example Health", status: "connected" })
    .returning({ id: healthSource.id });
  return row.id;
}

function resourceRow(sourceId: string, overrides: Partial<typeof fhirResource.$inferInsert> = {}) {
  return {
    userId,
    sourceId,
    resourceType: "Observation",
    fhirId: "obs-1",
    category: "lab",
    contentHmac: "h",
    sealedResource: "v2.x",
    sealedSummary: "v2.y",
    normalizerVersion: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

// drizzle-orm wraps driver errors; the D1 (SQLite) message is on the cause.
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return `${(error as Error).message} ${cause?.message ?? ""}`;
  }
  return "no error";
}

// One database per file (each takes seconds to migrate); each test gets its own user.
let nextUser = 0;
const newUser = () => createTestUser(db, `user_${++nextUser}`);

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  userId = await newUser();
});

describe("fhir_resource", () => {
  it("allows one current version per resource, and any number of superseded ones", async () => {
    const sourceId = await addSource();
    const [old] = await db.insert(fhirResource).values(resourceRow(sourceId)).returning();
    expect(await failure(db.insert(fhirResource).values(resourceRow(sourceId)))).toMatch(/UNIQUE constraint failed: fhir_resource\.source_id, fhir_resource\.resource_type, fhir_resource\.fhir_id/);

    const [current] = await db.insert(fhirResource).values(resourceRow(sourceId, { supersededAt: now })).returning();
    await db.update(fhirResource).set({ supersededAt: now, supersededBy: current.id }).where(eq(fhirResource.id, old.id));
    await db.update(fhirResource).set({ supersededAt: null }).where(eq(fhirResource.id, current.id));
    const rows = await db.select().from(fhirResource).where(eq(fhirResource.sourceId, sourceId));
    expect(rows.filter((r) => r.supersededAt === null)).toHaveLength(1);
  });

  it("treats the same FHIR id from two sources as two resources", async () => {
    const a = await addSource();
    const b = await addSource(userId, "https://fhir.other.org/R4");
    await db.insert(fhirResource).values([resourceRow(a), resourceRow(b)]);
    expect(await db.select().from(fhirResource).where(eq(fhirResource.userId, userId))).toHaveLength(2);
  });
});

describe("sync_run", () => {
  it("allows only one queued or running run per source", async () => {
    const sourceId = await addSource();
    await db.insert(syncRun).values({ userId, sourceId, trigger: "connect", status: "running" });
    expect(await failure(db.insert(syncRun).values({ userId, sourceId, trigger: "manual", status: "queued" }))).toMatch(
      /UNIQUE constraint failed: sync_run\.source_id/,
    );
    await db.update(syncRun).set({ status: "ok" }).where(eq(syncRun.sourceId, sourceId));
    await db.insert(syncRun).values({ userId, sourceId, trigger: "manual", status: "queued" });
    expect(await db.select().from(syncRun).where(eq(syncRun.sourceId, sourceId))).toHaveLength(2);
  });
});

describe("account deletion", () => {
  it("deletes every stored record, source, run and key", async () => {
    const sourceId = await addSource();
    await db.insert(fhirResource).values(resourceRow(sourceId));
    await db.insert(syncRun).values({ userId, sourceId, trigger: "connect", status: "ok" });
    await db.insert(userDataKey).values({ userId, sealedDek: "v2.x", kekVersion: 1 });
    await db.delete(user).where(eq(user.id, userId));
    expect(await db.select().from(healthSource).where(eq(healthSource.userId, userId))).toEqual([]);
    expect(await db.select().from(fhirResource).where(eq(fhirResource.userId, userId))).toEqual([]);
    expect(await db.select().from(syncRun).where(eq(syncRun.userId, userId))).toEqual([]);
    expect(await db.select().from(userDataKey).where(eq(userDataKey.userId, userId))).toEqual([]);
  });
});
