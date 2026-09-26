import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { userKeysFor, type UserKeys } from "@/lib/crypto/user-keys";
import { epicConnection, healthSource, syncRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { deleteConnection, saveConnection } from "@/lib/epic/connections";
import type { Resource } from "@/lib/fhir/types";
import { createTestDb, createTestUser } from "@/test/db";
import { sourceProblems } from "./source-display";
import { deleteSource, listSources, needingFirstSync, type SourceSummary } from "./sources";
import { runSyncJob } from "./sync/job";
import { SYNC_QUERIES } from "./sync/plan";
import { STALE_RUN_MS, startRun, type SyncDeps } from "./sync/run";
import {
  countsFor,
  encodeCursor,
  filterQuery,
  parseCursor,
  parseFilters,
  sourceTones,
  timelinePage,
  type TimelineFilters,
} from "./timeline";

const ALL: TimelineFilters = { sourceIds: [], categories: [], from: null, to: null };

const tokenKey = randomBytes(32);
const kek = randomBytes(32);
const now = new Date("2026-09-26T12:00:00Z");
const QUERIES = SYNC_QUERIES.filter((q) => ["Observation:lab", "Condition:condition"].includes(q.key));
let db: Db;
let userId: string;
let keys: UserKeys;
let nextUser = 0;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  userId = await createTestUser(db, `store_user_${++nextUser}`);
  keys = await userKeysFor(db, kek, userId, now);
});

async function connect(organizationName: string, fhirBaseUrl: string): Promise<string> {
  const { sourceId } = await saveConnection(
    db,
    tokenKey,
    {
      userId,
      fhirBaseUrl,
      organizationName,
      tokenEndpoint: `${fhirBaseUrl}/token`,
      tokens: { accessToken: "at", refreshToken: "rt", expiresAt: now, scope: "s", patientId: "p1" },
    },
    now,
  );
  return sourceId;
}

// Imports resources for a source through the real sync job, with a fake FHIR server.
async function importInto(sourceId: string, organizationName: string, byPath: Record<string, Resource[]>): Promise<void> {
  const { runId } = await startRun(db, { userId, sourceId, trigger: "connect" }, now);
  const search: SyncDeps["search"] = async ({ path }) => ({ resources: byPath[path.split("&_lastUpdated=")[0]] ?? [], truncated: false });
  const deps: SyncDeps = { db, keys, now: () => now, accessToken: async () => "at", search };
  const source = { runId, userId, sourceId, organizationName, fhirBaseUrl: "https://x", patientId: "p1" };
  await runSyncJob({ runId, userId, sourceId }, (_id, work) => work(), { db, now: () => now, load: async () => ({ deps, source }) }, QUERIES);
}

const lab = (id: string, date: string, title: string): Resource =>
  ({ resourceType: "Observation", id, status: "final", code: { text: title }, effectiveDateTime: date }) as Resource;

describe("timelinePage", () => {
  it("merges every source into one list, newest first, each tagged with its organization", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    const south = await connect("South Hospital", "https://south.example/R4");
    await importInto(north, "North Clinic", { "Observation?patient=p1&category=laboratory": [lab("n1", "2024-01-05", "A1c")] });
    await importInto(south, "South Hospital", {
      "Observation?patient=p1&category=laboratory": [lab("s1", "2025-06-01", "Lipid panel")],
      "Condition?patient=p1&category=problem-list-item": [{ resourceType: "Condition", id: "c1", code: { text: "Asthma" } } as Resource],
    });

    const sources = await listSources(db, userId);
    const { items } = await timelinePage(db, keys, userId, sources, ALL, null);
    expect(items.map((i) => [i.title, i.source])).toEqual([
      ["Lipid panel", "South Hospital"],
      ["A1c", "North Clinic"],
      ["Asthma", "South Hospital"],
    ]);
    const [northConnection] = await db.select().from(epicConnection).where(eq(epicConnection.sourceId, north));
    expect(items.find((i) => i.title === "A1c")).toMatchObject({ connectionId: northConnection.id, resource: { id: "n1" } });
  });

  it("keeps showing records from a disconnected source, without a connection to load notes through", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    await importInto(north, "North Clinic", { "Observation?patient=p1&category=laboratory": [lab("n1", "2024-01-05", "A1c")] });
    const [connection] = await db.select().from(epicConnection).where(eq(epicConnection.sourceId, north));
    await deleteConnection(db, userId, connection.id, now);

    const sources = await listSources(db, userId);
    expect(sources[0]).toMatchObject({ status: "disconnected", connectionId: null, recordCount: 1, categoryCounts: { lab: 1 } });
    const { items } = await timelinePage(db, keys, userId, sources, ALL, null);
    expect(items).toEqual([expect.objectContaining({ title: "A1c", connectionId: "" })]);
  });

  it("never returns another person's records", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    await importInto(north, "North Clinic", { "Observation?patient=p1&category=laboratory": [lab("n1", "2024-01-05", "A1c")] });
    const other = await createTestUser(db, `store_user_${++nextUser}`);
    const otherKeys = await userKeysFor(db, kek, other, now);
    const { items } = await timelinePage(db, otherKeys, other, await listSources(db, other), ALL, null);
    expect(items).toEqual([]);
  });
});

describe("sources", () => {
  it("reports a source's sync state and record count", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    expect(needingFirstSync(await listSources(db, userId)).map((s) => s.id)).toEqual([north]);

    await startRun(db, { userId, sourceId: north, trigger: "connect" }, now);
    const [importing] = await listSources(db, userId, now);
    expect(importing).toMatchObject({ syncing: true, lastSyncedAt: null });
    expect(needingFirstSync([importing])).toEqual([]);
  });

  it("stops reporting a lost run as importing once it's stale, so a first sync is queued again", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    await startRun(db, { userId, sourceId: north, trigger: "connect" }, now);
    const later = new Date(now.getTime() + STALE_RUN_MS + 1);
    const [lost] = await listSources(db, userId, later);
    expect(lost.syncing).toBe(false);
    expect(needingFirstSync([lost]).map((s) => s.id)).toEqual([north]);
  });

  it("reports the stats of the latest finished run", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    const stats = (errorCode?: string) => ({ fetched: 0, inserted: 0, superseded: 0, unchanged: 0, removed: 0, ...(errorCode ? { errorCode } : {}) });
    await db.insert(syncRun).values([
      { userId, sourceId: north, trigger: "connect", status: "partial", stats: { "Observation:lab": stats("500") }, queuedAt: new Date(now.getTime() - 60_000) },
      { userId, sourceId: north, trigger: "manual", status: "ok", stats: { "Observation:lab": stats() }, queuedAt: now },
    ]);
    const [source] = await listSources(db, userId, now);
    expect(source.lastRunStats).toEqual({ "Observation:lab": stats() });
  });

  it("deletes a source with its records, tokens and history, only for its owner", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    await importInto(north, "North Clinic", { "Observation?patient=p1&category=laboratory": [lab("n1", "2024-01-05", "A1c")] });
    const other = await createTestUser(db, `store_user_${++nextUser}`);
    expect(await deleteSource(db, other, north)).toBe(false);
    expect(await deleteSource(db, userId, north)).toBe(true);
    expect(await listSources(db, userId)).toEqual([]);
    expect(await db.select().from(epicConnection).where(eq(epicConnection.sourceId, north))).toEqual([]);
    expect(await db.select().from(syncRun).where(eq(syncRun.sourceId, north))).toEqual([]);
    expect((await timelinePage(db, keys, userId, await listSources(db, userId), ALL, null)).items).toEqual([]);
  });
});

describe("sourceProblems", () => {
  const base: SourceSummary = {
    id: "s",
    organizationName: "North Clinic",
    fhirBaseUrl: "https://north.example/R4",
    status: "connected",
    connectionId: "c",
    lastSyncedAt: now,
    lastSyncStatus: "ok",
    syncing: false,
    lastRunStats: {},
    recordCount: 1,
    categoryCounts: { lab: 1 },
  };
  const stats = (errorCode?: string) => ({ fetched: 1, inserted: 1, superseded: 0, unchanged: 0, removed: 0, ...(errorCode ? { errorCode } : {}) });

  it("says when a source is importing, needs reconnecting, or couldn't load everything", () => {
    expect(sourceProblems([{ ...base, syncing: true }])).toEqual([{ organizationName: "North Clinic", kind: "importing" }]);
    expect(sourceProblems([{ ...base, status: "reconnect_required" }])).toEqual([{ organizationName: "North Clinic", kind: "reconnect" }]);
    expect(sourceProblems([{ ...base, lastRunStats: { "Observation:lab": stats("truncated"), "Condition:condition": stats("500") } }])).toEqual([
      { organizationName: "North Clinic", kind: "unavailable" },
      { organizationName: "North Clinic", kind: "partial", categories: ["lab"] },
    ]);
  });

  it("stays quiet for healthy and disconnected sources", () => {
    expect(sourceProblems([{ ...base, lastRunStats: { "Observation:lab": stats() } }])).toEqual([]);
    expect(sourceProblems([{ ...base, status: "disconnected", lastRunStats: { "Observation:lab": stats("500") } }])).toEqual([]);
  });

  it("isn't fooled by a source reported for someone else", async () => {
    // listSources filters on the user; a source row for another person never appears.
    const other = await createTestUser(db, `store_user_${++nextUser}`);
    await db.insert(healthSource).values({ userId: other, vendor: "epic", fhirBaseUrl: "https://x", organizationName: "X", status: "connected" });
    expect(await listSources(db, userId)).toEqual([]);
  });
});

describe("timeline filters and paging", () => {
  const LAB = "Observation?patient=p1&category=laboratory";
  const CONDITION = "Condition?patient=p1&category=problem-list-item";

  async function twoSources() {
    const north = await connect("North Clinic", "https://north.example/R4");
    const south = await connect("South Hospital", "https://south.example/R4");
    await importInto(north, "North Clinic", {
      [LAB]: [lab("n1", "2024-01-05", "A1c"), lab("n2", "2025-03-01", "TSH"), lab("n3", "2023-07-19", "Ferritin")],
    });
    await importInto(south, "South Hospital", {
      [LAB]: [lab("s1", "2025-06-01", "Lipid panel")],
      [CONDITION]: [{ resourceType: "Condition", id: "c1", code: { text: "Asthma" } } as Resource],
    });
    return { north, south, sources: await listSources(db, userId) };
  }

  it("filters by health system, type and dates", async () => {
    const { north, sources } = await twoSources();
    const titles = async (filters: Partial<TimelineFilters>) =>
      (await timelinePage(db, keys, userId, sources, { ...ALL, ...filters }, null)).items.map((i) => i.title);

    expect(await titles({ sourceIds: [north] })).toEqual(["TSH", "A1c", "Ferritin"]);
    expect(await titles({ categories: ["condition"] })).toEqual(["Asthma"]);
    expect(await titles({ from: "2024-01-05", to: "2025-03-01" })).toEqual(["TSH", "A1c"]);
  });

  it("pages newest first, through the undated records, with no repeats or gaps", async () => {
    const { sources } = await twoSources();
    const seen: string[] = [];
    let cursor = null;
    for (let i = 0; i < 10; i++) {
      const page: Awaited<ReturnType<typeof timelinePage>> = await timelinePage(db, keys, userId, sources, ALL, cursor, 2);
      seen.push(...page.items.map((item) => item.title));
      if (!page.next) break;
      cursor = parseCursor(encodeCursor(page.next));
    }
    expect(seen).toEqual(["Lipid panel", "TSH", "A1c", "Ferritin", "Asthma"]);
  });

  it("shows an amended record once, with the version it replaced", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    await importInto(north, "North Clinic", { [LAB]: [lab("n1", "2024-01-05", "A1c")] });
    const changed = { ...lab("n1", "2024-01-05", "A1c"), valueQuantity: { value: 6.1, unit: "%" } } as Resource;
    await importInto(north, "North Clinic", { [LAB]: [changed] });

    const { items } = await timelinePage(db, keys, userId, await listSources(db, userId), ALL, null);
    expect(items).toHaveLength(1);
    expect(items[0].history).toEqual([{ replacedAt: expect.any(String), resource: expect.objectContaining({ id: "n1" }) }]);
    expect((items[0].resource as { valueQuantity?: { value: number } }).valueQuantity?.value).toBe(6.1);
  });

  it("counts records per type for the chosen health systems, and colors each system", async () => {
    const { north, south, sources } = await twoSources();
    expect(countsFor(sources, ALL)).toMatchObject({ lab: 4, condition: 1 });
    expect(countsFor(sources, { ...ALL, sourceIds: [south] })).toMatchObject({ lab: 1, condition: 1 });
    expect(sourceTones(sources)).toEqual({ [north]: 0, [south]: 1 });
  });
});

describe("timeline URLs", () => {
  const source = (id: string) => ({ id }) as SourceSummary;
  const own = "3f2b1c4d-0000-4000-8000-000000000001";

  it("keeps only the person's own sources, known types and real dates", () => {
    const filters = parseFilters(
      { org: [own, "someone-elses"], type: ["labs", "nope", "labs"], from: "2024-02-30x", to: "2025-01-31" },
      [source(own)],
    );
    expect(filters).toEqual({ sourceIds: [own], categories: ["lab"], from: null, to: "2025-01-31" });
  });

  it("round-trips a page cursor and rejects anything malformed", () => {
    const cursor = { at: new Date("2024-01-05T00:00:00Z"), id: own };
    expect(parseCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(parseCursor(encodeCursor({ at: null, id: own }))).toEqual({ at: null, id: own });
    expect(parseCursor("2024-01-05_not-an-id")).toBeNull();
    expect(parseCursor("yesterday_" + own)).toBeNull();
    expect(parseCursor(undefined)).toBeNull();
  });

  it("builds query strings for links and forms", () => {
    expect(filterQuery(ALL)).toBe("");
    expect(filterQuery({ sourceIds: [own], categories: ["lab"], from: "2024-01-01", to: null }, { at: null, id: own })).toBe(
      `?org=${own}&type=labs&from=2024-01-01&before=undated_${own}`,
    );
  });
});
