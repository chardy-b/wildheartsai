import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { userKeysFor, type UserKeys } from "@/lib/crypto/user-keys";
import { fhirResource, healthSource, syncCursor, syncRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import type { Observation, Resource } from "@/lib/fhir/types";
import { createTestDb, createTestUser } from "@/test/db";
import { SYNC_QUERIES } from "./plan";
import { runSyncJob } from "./job";
import { startRun, type SyncDeps, type SyncSource } from "./run";
import { openStoredRow } from "./store";

const QUERIES = SYNC_QUERIES.filter((q) => ["Observation:lab", "Observation:vital", "Condition:condition"].includes(q.key));
const kek = randomBytes(32);

// A FHIR server holding resources per search path (without _lastUpdated). How it
// treats _lastUpdated is configurable, as Epic's support varies by resource.
function fakeServer() {
  const data = new Map<string, Resource[]>();
  const failing = new Map<string, Error>();
  const calls: string[] = [];
  let lastUpdated: "honour" | "ignore" | "error" = "honour";
  let cap = Infinity;

  const search: SyncDeps["search"] = async ({ path, maxResources }) => {
    calls.push(path);
    const [base, since] = path.split("&_lastUpdated=");
    const error = failing.get(base);
    if (error) throw error;
    let resources = data.get(base) ?? [];
    if (since) {
      if (lastUpdated === "error") throw new EpicError("fhir", 400);
      if (lastUpdated === "honour") {
        const after = new Date(decodeURIComponent(since).slice(2));
        resources = resources.filter((r) => new Date((r as { meta?: { lastUpdated: string } }).meta?.lastUpdated ?? 0) > after);
      }
    }
    const limit = Math.min(cap, maxResources);
    return { resources: resources.slice(0, limit), truncated: resources.length > limit };
  };

  return {
    search,
    calls,
    set: (path: string, resources: Resource[]) => data.set(path, resources),
    fail: (path: string, error: Error) => failing.set(path, error),
    lastUpdated: (mode: typeof lastUpdated) => (lastUpdated = mode),
    cap: (n: number) => (cap = n),
  };
}

const LAB = "Observation?patient=p1&category=laboratory";
const VITAL = "Observation?patient=p1&category=vital-signs";
const CONDITION = "Condition?patient=p1&category=problem-list-item";

const lab = (id: string, value: number, updated = "2026-09-01T00:00:00Z", extra: object = {}): Resource =>
  ({
    resourceType: "Observation",
    id,
    meta: { lastUpdated: updated },
    status: "final",
    code: { text: `Test ${id}` },
    valueQuantity: { value, unit: "mg/dL" },
    effectiveDateTime: "2026-08-15",
    ...extra,
  }) as Resource;

let db: Db;
let userId: string;
let keys: UserKeys;
let sourceId: string;
let server: ReturnType<typeof fakeServer>;
let clock: Date;
let nextUser = 0;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  userId = await createTestUser(db, `sync_user_${++nextUser}`);
  keys = await userKeysFor(db, kek, userId, new Date());
  const [source] = await db
    .insert(healthSource)
    .values({ userId, vendor: "epic", fhirBaseUrl: "https://fhir.example.org/R4", organizationName: "Example Health", status: "connected" })
    .returning({ id: healthSource.id });
  sourceId = source.id;
  server = fakeServer();
  clock = new Date("2026-09-26T12:00:00Z");
});

function deps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return { db, keys, now: () => clock, accessToken: async () => "token", search: server.search, ...overrides };
}

async function sync(overrides: Partial<SyncDeps> = {}) {
  const { runId } = await startRun(db, { userId, sourceId, trigger: "manual" }, clock);
  const source: SyncSource = { runId, userId, sourceId, organizationName: "Example Health", fhirBaseUrl: "https://fhir.example.org/R4", patientId: "p1" };
  const status = await runSyncJob(
    { runId, userId, sourceId },
    (_id, work) => work(),
    { db, now: () => clock, load: async () => ({ deps: deps(overrides), source }) },
    QUERIES,
  );
  const [run] = await db.select().from(syncRun).where(eq(syncRun.id, runId));
  return { status, run };
}

const rows = () => db.select().from(fhirResource).where(eq(fhirResource.sourceId, sourceId));
const current = () =>
  db.select().from(fhirResource).where(and(eq(fhirResource.sourceId, sourceId), isNull(fhirResource.supersededAt)));
const later = (hours: number) => (clock = new Date(clock.getTime() + hours * 3600_000));

describe("first sync", () => {
  it("stores every resource, sealed, with a readable summary and a sortable date", async () => {
    server.set(LAB, [lab("a", 5.4), lab("b", 6.1)]);
    server.set(CONDITION, [{ resourceType: "Condition", id: "c1", code: { text: "Asthma" }, onsetDateTime: "2019" } as Resource]);
    const { status, run } = await sync();

    expect(status).toBe("ok");
    expect(run.stats["Observation:lab"]).toMatchObject({ fetched: 2, inserted: 2 });
    const stored = await rows();
    expect(stored).toHaveLength(3);
    expect(JSON.stringify(stored)).not.toMatch(/Asthma|Test a|5\.4/);

    const asthma = stored.find((r) => r.fhirId === "c1")!;
    expect(asthma).toMatchObject({ category: "condition", effectiveAt: new Date("2019-01-01T00:00:00Z"), datePrecision: "year" });
    expect(openStoredRow(keys, asthma)).toMatchObject({ resource: { id: "c1" }, summary: { title: "Asthma", source: "Example Health" } });
    expect(stored.find((r) => r.fhirId === "a")!.sourceUpdatedAt).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  it("records the source's last sync", async () => {
    server.set(LAB, [lab("a", 5.4)]);
    await sync();
    const [source] = await db.select().from(healthSource).where(eq(healthSource.id, sourceId));
    expect(source).toMatchObject({ lastSyncStatus: "ok", lastSyncedAt: clock });
  });
});

describe("later syncs", () => {
  it("store nothing new when nothing changed", async () => {
    server.lastUpdated("ignore"); // every sync is a full pull
    server.set(LAB, [lab("a", 5.4), lab("b", 6.1)]);
    await sync();
    later(1);
    const { run } = await sync();
    expect(run.stats["Observation:lab"]).toMatchObject({ inserted: 0, superseded: 0, unchanged: 2 });
    expect(await rows()).toHaveLength(2);
  });

  it("keep the earlier version of a changed record, marked superseded", async () => {
    server.set(LAB, [lab("a", 5.4)]);
    await sync();
    later(1);
    server.set(LAB, [lab("a", 5.9, "2026-09-26T12:30:00Z")]);
    const { run } = await sync();

    expect(run.stats["Observation:lab"]).toMatchObject({ superseded: 1 });
    const all = await rows();
    expect(all).toHaveLength(2);
    const [now] = await current();
    const old = all.find((r) => r.id !== now.id)!;
    expect(old).toMatchObject({ supersededAt: clock, supersededBy: now.id });
    expect((openStoredRow(keys, now).resource as Observation).valueQuantity?.value).toBe(5.9);
  });

  it("don't treat a bumped lastUpdated alone as a change", async () => {
    server.set(LAB, [lab("a", 5.4)]);
    await sync();
    later(1);
    server.set(LAB, [lab("a", 5.4, "2026-09-26T12:30:00Z")]);
    await sync();
    expect(await rows()).toHaveLength(1);
  });

  it("mark records missing from a full pull as removed, and restore them if they return", async () => {
    server.lastUpdated("ignore"); // every sync is a full pull
    server.set(LAB, [lab("a", 5.4), lab("b", 6.1)]);
    await sync();
    later(1);
    server.set(LAB, [lab("a", 5.4)]);
    await sync();
    expect((await current()).find((r) => r.fhirId === "b")!.removedAt).toEqual(clock);

    later(1);
    server.set(LAB, [lab("a", 5.4), lab("b", 6.1)]);
    await sync();
    expect((await current()).find((r) => r.fhirId === "b")!.removedAt).toBeNull();
  });

  it("hide records the source marks entered-in-error", async () => {
    server.set(LAB, [lab("a", 5.4)]);
    await sync();
    later(1);
    server.set(LAB, [lab("a", 5.4, "2026-09-26T12:30:00Z", { status: "entered-in-error" })]);
    await sync();
    const [row] = await current();
    expect(row.removedAt).toEqual(clock);
  });
});

describe("incremental sync", () => {
  it("probes _lastUpdated once, then only asks for what changed", async () => {
    server.set(LAB, [lab("a", 5.4, "2026-09-01T00:00:00Z")]);
    await sync();
    const [cursor] = await db
      .select()
      .from(syncCursor)
      .where(and(eq(syncCursor.sourceId, sourceId), eq(syncCursor.queryKey, "Observation:lab")));
    expect(cursor).toMatchObject({ supportsLastUpdated: true, lastFullAt: clock, lastSuccessAt: clock });

    later(2);
    server.calls.length = 0;
    server.set(LAB, [lab("a", 5.4, "2026-09-01T00:00:00Z"), lab("new", 7, "2026-09-26T13:00:00Z")]);
    const { run } = await sync();
    const labCall = server.calls.find((c) => c.startsWith(LAB))!;
    expect(labCall).toContain("_lastUpdated=");
    expect(run.stats["Observation:lab"]).toMatchObject({ fetched: 1, inserted: 1, removed: 0 });
    expect(await current()).toHaveLength(2);
  });

  it("keeps pulling in full where the server ignores or rejects _lastUpdated", async () => {
    for (const mode of ["ignore", "error"] as const) {
      server.lastUpdated(mode);
      server.set(LAB, [lab("a", 5.4)]);
      await sync();
      later(2);
      server.calls.length = 0;
      await sync();
      expect(server.calls.filter((c) => c.startsWith(LAB)).every((c) => !c.includes("_lastUpdated="))).toBe(true);
    }
  });
});

describe("failures", () => {
  it("stores what it can when one search fails, and reports the run as partial", async () => {
    server.set(LAB, [lab("a", 5.4)]);
    server.fail(CONDITION, new EpicError("fhir", 403));
    const { status, run } = await sync();
    expect(status).toBe("partial");
    expect(run.stats["Condition:condition"]).toMatchObject({ errorCode: "403" });
    expect(await rows()).toHaveLength(1);
  });

  it("stores a truncated search but doesn't treat anything as removed or advance its cursor", async () => {
    server.lastUpdated("ignore"); // every sync is a full pull
    server.set(LAB, [lab("a", 5.4), lab("b", 6.1)]);
    await sync();
    later(1);
    server.cap(1);
    const { status, run } = await sync();
    expect(status).toBe("partial");
    expect(run.stats["Observation:lab"]).toMatchObject({ errorCode: "truncated", removed: 0 });
    expect((await current()).every((r) => r.removedAt === null)).toBe(true);
  });

  it("marks the source for reconnecting when access is refused", async () => {
    server.set(LAB, [lab("a", 5.4)]);
    server.fail(VITAL, new ReconnectRequiredError());
    const { status, run } = await sync();
    expect(status).toBe("failed");
    expect(run.status).toBe("failed");
    const [source] = await db.select().from(healthSource).where(eq(healthSource.id, sourceId));
    expect(source.status).toBe("reconnect_required");
  });

  it("never records resource content in run stats", async () => {
    server.set(LAB, [lab("a", 5.4)]);
    server.fail(CONDITION, new EpicError("fhir", 500));
    const { run } = await sync();
    expect(JSON.stringify(run.stats)).not.toMatch(/Test a|5\.4|p1/);
  });
});

describe("startRun", () => {
  it("returns the active run instead of queuing a second one", async () => {
    const first = await startRun(db, { userId, sourceId, trigger: "manual" }, clock);
    const second = await startRun(db, { userId, sourceId, trigger: "scheduled" }, clock);
    expect(first.created).toBe(true);
    expect(second).toEqual({ runId: first.runId, created: false });
  });

  it("replaces a run that was lost, so it can't block syncing forever", async () => {
    const lost = await startRun(db, { userId, sourceId, trigger: "manual" }, clock);
    later(4);
    const next = await startRun(db, { userId, sourceId, trigger: "manual" }, clock);
    expect(next.created).toBe(true);
    const [old] = await db.select().from(syncRun).where(eq(syncRun.id, lost.runId));
    expect(old.status).toBe("failed");
  });
});
