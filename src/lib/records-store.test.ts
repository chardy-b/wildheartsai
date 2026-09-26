import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { userKeysFor, type UserKeys } from "@/lib/crypto/user-keys";
import { epicConnection, healthSource, syncRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { deleteConnection, saveConnection } from "@/lib/epic/connections";
import type { Resource } from "@/lib/fhir/types";
import { createTestDb, createTestUser } from "@/test/db";
import { loadStoredRecords, sourceProblems } from "./records-store";
import { deleteSource, listSources, needingFirstSync, type SourceSummary } from "./sources";
import { runSyncJob } from "./sync/job";
import { SYNC_QUERIES } from "./sync/plan";
import { startRun, type SyncDeps } from "./sync/run";

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

describe("loadStoredRecords", () => {
  it("merges every source into one list, newest first, each tagged with its organization", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    const south = await connect("South Hospital", "https://south.example/R4");
    await importInto(north, "North Clinic", { "Observation?patient=p1&category=laboratory": [lab("n1", "2024-01-05", "A1c")] });
    await importInto(south, "South Hospital", {
      "Observation?patient=p1&category=laboratory": [lab("s1", "2025-06-01", "Lipid panel")],
      "Condition?patient=p1&category=problem-list-item": [{ resourceType: "Condition", id: "c1", code: { text: "Asthma" } } as Resource],
    });

    const sources = await listSources(db, userId);
    const { items, problems } = await loadStoredRecords(db, keys, userId, sources);
    expect(items.map((i) => [i.title, i.source])).toEqual([
      ["Lipid panel", "South Hospital"],
      ["A1c", "North Clinic"],
      ["Asthma", "South Hospital"],
    ]);
    const [northConnection] = await db.select().from(epicConnection).where(eq(epicConnection.sourceId, north));
    expect(items.find((i) => i.title === "A1c")).toMatchObject({ connectionId: northConnection.id, resource: { id: "n1" } });
    expect(problems).toEqual([]);
  });

  it("keeps showing records from a disconnected source, without a connection to load notes through", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    await importInto(north, "North Clinic", { "Observation?patient=p1&category=laboratory": [lab("n1", "2024-01-05", "A1c")] });
    const [connection] = await db.select().from(epicConnection).where(eq(epicConnection.sourceId, north));
    await deleteConnection(db, userId, connection.id, now);

    const sources = await listSources(db, userId);
    expect(sources[0]).toMatchObject({ status: "disconnected", connectionId: null, recordCount: 1 });
    const { items } = await loadStoredRecords(db, keys, userId, sources);
    expect(items).toEqual([expect.objectContaining({ title: "A1c", connectionId: "" })]);
  });

  it("never returns another person's records", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    await importInto(north, "North Clinic", { "Observation?patient=p1&category=laboratory": [lab("n1", "2024-01-05", "A1c")] });
    const other = await createTestUser(db, `store_user_${++nextUser}`);
    const otherKeys = await userKeysFor(db, kek, other, now);
    const { items } = await loadStoredRecords(db, otherKeys, other, await listSources(db, other));
    expect(items).toEqual([]);
  });
});

describe("sources", () => {
  it("reports a source's sync state and record count", async () => {
    const north = await connect("North Clinic", "https://north.example/R4");
    expect(needingFirstSync(await listSources(db, userId)).map((s) => s.id)).toEqual([north]);

    await startRun(db, { userId, sourceId: north, trigger: "connect" }, now);
    const [importing] = await listSources(db, userId);
    expect(importing).toMatchObject({ syncing: true, lastSyncedAt: null });
    expect(needingFirstSync([importing])).toEqual([]);
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
    expect((await loadStoredRecords(db, keys, userId, [])).items).toEqual([]);
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
