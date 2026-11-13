import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { SYNC_QUERIES, NORMALIZER_VERSION } from "@/lib/sync/plan";
import { parseFilters, type TimelineFilters } from "@/lib/timeline-filters";
import { hmacFor, sealField, type UserKeys } from "../src/crypto/fields";
import { allMatching, storedNoteText, timelinePage } from "../src/data/records";
import { listSources } from "../src/data/sources";
import { userKeysFor } from "../src/data/user-keys";
import * as s from "../src/db/schema";
import { clearAll, db, person, recordsKey } from "./helpers";

// The timeline read path on D1, with rows sealed the way the sync job writes them.
const ALL: TimelineFilters = { sourceIds: [], categories: [], from: null, to: null };
const at = new Date("2026-11-01T12:00:00.000Z");
const lab = SYNC_QUERIES.find((q) => q.key === "Observation:lab")!;

type Seed = { fhirId: string; date: string | null; supersededAt?: Date; category?: string | null; resource?: Record<string, unknown>; normalizerVersion?: number };

function sealedRow(keys: UserKeys, userId: string, sourceId: string, seed: Seed) {
  const id = crypto.randomUUID();
  const resource = seed.resource ?? {
    resourceType: "Observation",
    id: seed.fhirId,
    status: "final",
    code: { text: `Made-up test ${seed.fhirId}` },
    ...(seed.date ? { effectiveDateTime: seed.date } : {}),
    valueQuantity: { value: 1, unit: "mg/dL" },
    performer: [{ reference: "Practitioner/doc-1" }],
  };
  const summary = seed.category === null ? { key: "x", category: null, title: "Doctor", date: null, detail: null, status: null, source: "Example Health" } : lab.normalize(resource as never, "Example Health");
  return {
    id,
    userId,
    sourceId,
    resourceType: resource.resourceType as string,
    fhirId: seed.fhirId,
    category: seed.category === undefined ? "lab" : seed.category,
    effectiveAt: seed.date ? new Date(seed.date) : null,
    contentHmac: "hmac",
    sealedResource: sealField(keys, JSON.stringify(resource), { table: "fhir_resource", field: "resource", rowId: id }),
    sealedSummary: sealField(keys, JSON.stringify(summary), { table: "fhir_resource", field: "summary", rowId: id }),
    normalizerVersion: seed.normalizerVersion ?? NORMALIZER_VERSION,
    firstSeenAt: at,
    lastSeenAt: at,
    supersededAt: seed.supersededAt ?? null,
  };
}

async function insertRows(rows: ReturnType<typeof sealedRow>[]) {
  // 19 columns: five rows stay under D1's 100 bound parameters per statement.
  for (let i = 0; i < rows.length; i += 5) await db.insert(s.fhirResource).values(rows.slice(i, i + 5));
}

async function seeded(userId: string, count: number, undated = 0) {
  const scope = await person(userId);
  const sourceId = `${userId}-source`;
  await db.insert(s.healthSource).values({ id: sourceId, userId, vendor: "epic", fhirBaseUrl: `https://fhir.example.test/${userId}`, organizationName: "Example Health", status: "connected" });
  const keys = await userKeysFor(scope, recordsKey, at);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    rows.push(sealedRow(keys, userId, sourceId, { fhirId: `obs-${i}`, date: `${day}T08:00:00Z` }));
    // An earlier version of every record: the history lookup then covers a whole page of ids.
    rows.push(sealedRow(keys, userId, sourceId, { fhirId: `obs-${i}`, date: `${day}T08:00:00Z`, supersededAt: new Date(at.getTime() - 86_400_000) }));
  }
  for (let i = 0; i < undated; i++) rows.push(sealedRow(keys, userId, sourceId, { fhirId: `undated-${i}`, date: null }));
  rows.push(sealedRow(keys, userId, sourceId, { fhirId: "doc-1", date: null, category: null, resource: { resourceType: "Practitioner", id: "doc-1", name: [{ text: "Dr. Made-Up" }] } }));
  await insertRows(rows);
  return { scope, keys, sourceId, sources: await listSources(scope) };
}

beforeEach(clearAll);

describe("timeline on D1", () => {
  it("pages newest first, undated last, with history and linked records, across D1's parameter limit", async () => {
    const { scope, keys, sources } = await seeded("a", 120, 3);
    const first = await timelinePage(scope, keys, sources, ALL, null);
    expect(first.items).toHaveLength(100);
    expect(first.items[0].resource.id).toBe("obs-119");
    // 100 ids in one page: the earlier-versions query runs in slices.
    expect(first.items.every((item) => item.history?.length === 1)).toBe(true);
    expect(first.items[0].linked).toEqual([{ key: "Practitioner/doc-1", resource: expect.objectContaining({ id: "doc-1" }) }]);

    const second = await timelinePage(scope, keys, sources, ALL, first.next);
    expect(second.next).toBeNull();
    expect(second.items.map((i) => i.resource.id).slice(-3).sort()).toEqual(["undated-0", "undated-1", "undated-2"]);
    const all = [...first.items, ...second.items].map((i) => i.resource.id);
    expect(new Set(all).size).toBe(123);
    expect(await allMatching(scope, keys, sources, ALL, 50)).toHaveLength(123);
  });

  it("filters by date and category, leaving out undated records", async () => {
    const { scope, keys, sources } = await seeded("a", 10, 2);
    const january = await timelinePage(scope, keys, sources, { ...ALL, from: "2026-01-03", to: "2026-01-05" }, null);
    expect(january.items.map((i) => i.resource.id)).toEqual(["obs-4", "obs-3", "obs-2"]);
    expect((await timelinePage(scope, keys, sources, { ...ALL, categories: ["condition"] }, null)).items).toEqual([]);
  });

  it("shows a person only their own records, whatever ids they pass", async () => {
    const a = await seeded("a", 3);
    const b = await person("b");
    const bKeys = await userKeysFor(b, recordsKey, at);
    const bSources = await listSources(b);
    expect(parseFilters({ org: [a.sourceId] }, bSources).sourceIds).toEqual([]);
    // Even handed a's source summaries, b's scope reads nothing.
    expect((await timelinePage(b, bKeys, a.sources, ALL, null)).items).toEqual([]);
  });

  it("recomputes summaries stored by an older normalizer", async () => {
    const scope = await person("a");
    await db.insert(s.healthSource).values({ id: "src", userId: "a", vendor: "epic", fhirBaseUrl: "https://fhir.example.test/a", organizationName: "Example Health", status: "connected" });
    const keys = await userKeysFor(scope, recordsKey, at);
    const row = sealedRow(keys, "a", "src", { fhirId: "old", date: "2026-02-01T00:00:00Z", normalizerVersion: 1 });
    row.sealedSummary = sealField(keys, JSON.stringify({ key: "k", category: "lab", title: "stale title", date: null, detail: null, status: null, source: "Example Health" }), { table: "fhir_resource", field: "summary", rowId: row.id });
    await insertRows([row]);
    const [item] = (await timelinePage(scope, keys, await listSources(scope), ALL, null)).items;
    expect(item.title).not.toBe("stale title");
  });

  it("finds a stored note's text by its address", async () => {
    const { scope, keys, sourceId } = await seeded("a", 1);
    const [resource] = await db.select().from(s.fhirResource).where(eq(s.fhirResource.fhirId, "obs-0")).limit(1);
    const id = crypto.randomUUID();
    const url = "Binary/made-up-note";
    await db.insert(s.fhirAttachment).values({ id, userId: "a", sourceId, resourceId: resource.id, sealedUrl: "sealed", urlHmac: hmacFor(keys, url), sealedText: sealField(keys, "Made-up note text", { table: "fhir_attachment", field: "text", rowId: id }), fetchedAt: at });
    expect(await storedNoteText(scope, keys, sourceId, url)).toBe("Made-up note text");
    expect(await storedNoteText(scope, keys, sourceId, "Binary/other")).toBeUndefined();
    expect(await storedNoteText(await person("b"), keys, sourceId, url)).toBeUndefined();
  });
});
