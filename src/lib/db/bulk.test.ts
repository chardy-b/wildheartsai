import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { chunkBySize, insertRows, jsonValues } from "./bulk";
import { fhirResource, healthSource } from "./schema";
import type { Db } from "./types";

let db: Db;
let userId: string;
let sourceId: string;
const now = new Date("2026-09-26T10:00:00Z");

beforeAll(async () => {
  db = await createTestDb();
  userId = await createTestUser(db);
  [{ id: sourceId }] = await db
    .insert(healthSource)
    .values({ userId, vendor: "epic", fhirBaseUrl: "https://fhir.example.org/R4", organizationName: "Example Health", status: "connected" })
    .returning({ id: healthSource.id });
});

const row = (i: number) => ({
  id: crypto.randomUUID(),
  userId,
  sourceId,
  resourceType: "Observation",
  fhirId: `obs-${i}`,
  category: i % 2 ? "lab" : null,
  effectiveAt: i % 3 ? new Date(now.getTime() - i * 1000) : null,
  contentHmac: `h${i}`,
  sealedResource: "v2.x",
  sealedSummary: "v2.y",
  normalizerVersion: 1,
  firstSeenAt: now,
  lastSeenAt: now,
});

describe("insertRows", () => {
  // 500 rows × 19 columns is far past D1's 100 bound parameters per statement.
  it("inserts many rows in one statement, keeping types and defaults", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => row(i));
    await insertRows(db, fhirResource, rows);
    const stored = await db.select().from(fhirResource).where(eq(fhirResource.sourceId, sourceId));
    expect(stored).toHaveLength(500);
    const byId = new Map(stored.map((r) => [r.id, r]));
    for (const r of rows) {
      expect(byId.get(r.id)).toMatchObject({ ...r, supersededAt: null, removedAt: null });
    }
  });
});

describe("jsonValues", () => {
  it("matches any number of values", async () => {
    const ids = [...Array.from({ length: 300 }, (_, i) => `obs-${i}`), "obs-missing"];
    expect(await db.$count(fhirResource, inArray(fhirResource.fhirId, jsonValues(ids)))).toBe(300);
  });
});

describe("chunkBySize", () => {
  it("keeps each group under the limit, and never splits off an empty group", () => {
    expect(chunkBySize([4, 4, 4, 9, 1], (n) => n, 8)).toEqual([[4, 4], [4], [9], [1]]);
    expect(chunkBySize([], (n: number) => n, 8)).toEqual([]);
  });
});
