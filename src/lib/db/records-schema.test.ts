import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
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

// drizzle-orm wraps driver errors; the Postgres message is on the cause.
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
    expect(await failure(db.insert(fhirResource).values(resourceRow(sourceId)))).toMatch(/fhir_resource_current_idx/);

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
      /sync_run_active_idx/,
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

describe("migration 0003", () => {
  it("gives every existing connection a health_source", async () => {
    const files = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort();
    const pg = new PGlite();
    const run = async (file: string) => {
      for (const statement of readFileSync(`drizzle/${file}`, "utf8").split("--> statement-breakpoint")) {
        if (statement.trim()) await pg.exec(statement);
      }
    };
    for (const file of files.filter((f) => f < "0003")) await run(file);
    await pg.exec(`
      insert into "user" (id, name, email, email_verified, created_at, updated_at)
        values ('u1', 'Test', 'u1@example.com', true, now(), now());
      insert into epic_connection (id, user_id, fhir_base_url, organization_name, token_endpoint, sealed_patient_id,
        sealed_access_token, access_token_expires_at, scope)
        values ('c1', 'u1', 'https://fhir.example.org/R4', 'Example Health', 'https://t', 'v1.a', 'v1.b', now(), 's');
    `);
    await run(files.find((f) => f.startsWith("0003"))!);

    const { rows } = await pg.query<{ organization_name: string; status: string; linked: boolean }>(`
      select s.organization_name, s.status, c.source_id = s.id as linked
      from epic_connection c join health_source s on s.user_id = c.user_id and s.fhir_base_url = c.fhir_base_url`);
    expect(rows).toEqual([{ organization_name: "Example Health", status: "connected", linked: true }]);
    await expect(pg.exec(`update epic_connection set source_id = null`)).rejects.toThrow();
  });
});
