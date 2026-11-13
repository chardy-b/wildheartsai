import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { diffResources } from "@/lib/sync/diff";
import { SYNC_QUERIES } from "@/lib/sync/plan";
import type { UserScope } from "../src/data/scope";
import { userKeysFor } from "../src/data/user-keys";
import type { UserKeys } from "../src/crypto/fields";
import * as s from "../src/db/schema";
import { recordStats } from "../src/jobs/sync/run";
import { applyDiff, currentRows, prepareFetched, readCursor, saveCursor } from "../src/jobs/sync/store";
import { clearAll, db, person, recordsKey } from "./helpers";

// Writing a search's results on D1: thousands of records in few statements, versions replaced
// in several batches, and a repeated write (a retried step) that stores nothing twice.
const lab = SYNC_QUERIES.find((q) => q.key === "Observation:lab")!;
const now = new Date("2026-11-13T12:00:00.000Z");

let scope: UserScope;
let keys: UserKeys;
const sourceId = "source-1";

const observation = (i: number, value = 1) => ({
  resourceType: "Observation",
  id: `obs-${i}`,
  status: "final",
  code: { text: `Made-up test ${i} ${"x".repeat(400)}` },
  effectiveDateTime: "2026-01-01T00:00:00Z",
  valueQuantity: { value, unit: "mg/dL" },
});

async function store(resources: ReturnType<typeof observation>[]) {
  const items = prepareFetched(keys, resources);
  const stored = await currentRows(scope, sourceId, lab, items.map((i) => i.resource.id), true);
  const diff = diffResources(items, stored, { removalsIn: "lab" });
  return applyDiff(scope, keys, { userId: scope.userId, sourceId, organizationName: "Example Health", query: lab }, diff, now);
}

const current = () => db.select().from(s.fhirResource).where(and(eq(s.fhirResource.sourceId, sourceId), isNull(s.fhirResource.supersededAt)));

beforeEach(async () => {
  await clearAll();
  scope = await person("a");
  keys = await userKeysFor(scope, recordsKey, now);
  await db.insert(s.healthSource).values({ id: sourceId, userId: "a", vendor: "epic", fhirBaseUrl: "https://fhir.example.test", organizationName: "Example Health", status: "connected" });
});

describe("applyDiff on D1", () => {
  it("stores thousands of records, then only what changed", async () => {
    const all = Array.from({ length: 3000 }, (_, i) => observation(i));
    expect(await store(all)).toMatchObject({ inserted: 3000 });
    expect(await current()).toHaveLength(3000);

    // 120 amended (three batches of replacements), 10 gone, the rest the same.
    const next = all.slice(10).map((r, i) => (i < 120 ? observation(i + 10, 2) : r));
    expect(await store(next)).toEqual({ inserted: 0, superseded: 120, unchanged: 2870, removed: 10 });
    const rows = await current();
    expect(rows).toHaveLength(3000);
    expect(rows.filter((r) => r.removedAt)).toHaveLength(10);
    const replaced = await db.select().from(s.fhirResource).where(isNotNull(s.fhirResource.supersededAt));
    expect(replaced).toHaveLength(120);
    // Each replaced version points at its successor, a current row of the same resource.
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const old of replaced) expect(byId.get(old.supersededBy!)?.fhirId).toBe(old.fhirId);
  });

  it("stores nothing twice when a write is repeated", async () => {
    const resources = Array.from({ length: 50 }, (_, i) => observation(i));
    await store(resources);
    expect(await store(resources)).toMatchObject({ inserted: 0, superseded: 0, unchanged: 50 });
    expect(await current()).toHaveLength(50);
  });

  it("keeps each query's latest stats, and cursors only for the person's own sources", async () => {
    const [run] = await db.insert(s.syncRun).values({ userId: "a", sourceId, trigger: "manual", status: "running" }).returning();
    await recordStats(scope, run.id, "Observation:lab", { fetched: 1, inserted: 1, superseded: 0, unchanged: 0, removed: 0, errorCode: "500" });
    await recordStats(scope, run.id, "Observation:lab", { fetched: 2, inserted: 2, superseded: 0, unchanged: 0, removed: 0 });
    await recordStats(scope, run.id, "Condition:condition", { fetched: 0, inserted: 0, superseded: 0, unchanged: 0, removed: 0 });
    const [stored] = await db.select().from(s.syncRun).where(eq(s.syncRun.id, run.id));
    expect(stored.stats["Observation:lab"]).toEqual({ fetched: 2, inserted: 2, superseded: 0, unchanged: 0, removed: 0 });
    expect(Object.keys(stored.stats).sort()).toEqual(["Condition:condition", "Observation:lab"]);

    await saveCursor(scope, sourceId, "Observation:lab", { lastSuccessAt: now, supportsLastUpdated: true });
    await saveCursor(scope, sourceId, "Observation:lab", { lastFullAt: now });
    expect(await readCursor(scope, sourceId, "Observation:lab")).toEqual({ lastSuccessAt: now, lastFullAt: now, supportsLastUpdated: true });
    const other = await person("b");
    await saveCursor(other, sourceId, "Condition:condition", { lastSuccessAt: now });
    expect(await db.select().from(s.syncCursor)).toHaveLength(1);
  });
});
