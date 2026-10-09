import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { userKeysFor, type UserKeys } from "@/lib/crypto/user-keys";
import { fhirResource, healthSource, metriportConnection, syncRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { describeResource } from "@/lib/fhir/describe";
import { listSources } from "@/lib/sources";
import { timelinePage } from "@/lib/timeline";
import { createTestDb, createTestUser } from "@/test/db";
import { runSyncJob } from "@/lib/sync/job";
import { startRun } from "@/lib/sync/run";
import { MetriportError, createMetriportClient, externalIdFor, queryState, type DocumentQuery, type FhirBundle, type MetriportClient } from "./client";
import { deleteMetriportConnection, findPersonaConnection, getMetriportConnectionForSource, saveMetriportConnection } from "./connections";
import { clearBundleCache, metriportJob, waitForRecords } from "./job";
import { PERSONAS, personaById } from "./personas";
import { readFromBundle, searchBundle } from "./search";

// Metriport's sandbox consolidated bundle for its sample patient Jane Smith (made-up data, not PHI),
// recorded 2026-10-08 from GET /medical/v1/patient/{id}/consolidated.
const jane = JSON.parse(readFileSync(path.join(process.cwd(), "src/test/fixtures/metriport-sandbox/jane.json"), "utf8")) as FhirBundle;
const JANE = personaById("jane")!;
const kek = randomBytes(32);
const tokenKey = randomBytes(32);

function clientReturning(statuses: DocumentQuery[], bundle: FhirBundle = jane): MetriportClient & { polls: number; fetches: number } {
  const fake = {
    polls: 0,
    fetches: 0,
    facilityId: async () => "facility-1",
    createPatient: async () => ({ id: "mp-patient-1" }),
    startDocumentQuery: async () => ({ download: { status: "processing" as const } }),
    documentQueryStatus: async () => statuses[Math.min(fake.polls++, statuses.length - 1)],
    consolidated: async () => {
      fake.fetches++;
      return bundle;
    },
  };
  return fake;
}

describe("searchBundle", () => {
  it("answers category searches from the bundle's category codes", () => {
    const labs = searchBundle(jane, "Observation?patient=x&category=laboratory");
    const vitals = searchBundle(jane, "Observation?patient=x&category=vital-signs");
    expect(labs).toHaveLength(117);
    expect(vitals).toHaveLength(91);
    expect(searchBundle(jane, "Observation?patient=x&category=social-history")).toHaveLength(3);
    expect(searchBundle(jane, "Observation?patient=x&category=survey")).toHaveLength(0);
  });

  it("shows every condition once, as a problem, and none as diagnoses or concerns", () => {
    expect(searchBundle(jane, "Condition?patient=x&category=problem-list-item")).toHaveLength(30);
    expect(searchBundle(jane, "Condition?patient=x&category=encounter-diagnosis")).toEqual([]);
    expect(searchBundle(jane, "Condition?patient=x&category=health-concern")).toEqual([]);
  });

  it("returns uncategorised types whole, and nothing for searches the bundle can't answer", () => {
    expect(searchBundle(jane, "Encounter?patient=x")).toHaveLength(43);
    expect(searchBundle(jane, "DocumentReference?patient=x&category=clinical-note")).toHaveLength(48);
    expect(searchBundle(jane, "Appointment?patient=x&service-category=appointment")).toEqual([]);
    expect(searchBundle(jane, "Goal?patient=x")).toEqual([]);
  });

  it("reads a referenced resource by address", () => {
    const practitioner = jane.entry!.find((e) => e.resource?.resourceType === "Practitioner")!.resource!;
    expect(readFromBundle(jane, `Practitioner/${practitioner.id}`)).toBe(practitioner);
    expect(readFromBundle(jane, "Practitioner/nope")).toBeUndefined();
    expect(readFromBundle(jane, "Patient/whatever")).toBeUndefined();
  });
});

describe("waitForRecords", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  beforeEach(() => (sleeps.length = 0));

  it("returns once the download completes", async () => {
    const client = clientReturning([{ download: { status: "processing" } }, { download: { status: "processing" } }, { download: { status: "completed" } }]);
    await waitForRecords(client, "p", { sleep });
    expect(client.polls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("treats the sandbox's status without a download stage as ready", () => {
    expect(queryState({})).toBe("completed");
  });

  it("throws for the queue to retry when the pull is still running, and when it failed", async () => {
    await expect(waitForRecords(clientReturning([{ download: { status: "processing" } }]), "p", { sleep, pollForMs: 6_000 })).rejects.toThrow(MetriportError);
    await expect(waitForRecords(clientReturning([{ download: { status: "failed" } }]), "p", { sleep })).rejects.toMatchObject({ code: "query_failed" });
  });
});

describe("client", () => {
  it("sends the key as x-api-key to the sandbox only, and never leaks it in errors", async () => {
    const calls: { url: string; key: string | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, key: new Headers(init.headers).get("x-api-key") });
      return new Response("nope", { status: 401 });
    }) as unknown as typeof fetch;
    const error = await createMetriportClient("secret-key", fetchImpl).consolidated("p1").catch((e: unknown) => e);
    expect(calls).toEqual([{ url: "https://api.sandbox.metriport.com/medical/v1/patient/p1/consolidated", key: "secret-key" }]);
    expect(error).toBeInstanceOf(MetriportError);
    expect((error as MetriportError).status).toBe(401);
    expect(String((error as Error).message)).not.toContain("secret-key");
  });

  it("gives the same Metriport external id to the same person and persona only", () => {
    expect(externalIdFor("u1", JANE)).toBe(externalIdFor("u1", JANE));
    expect(externalIdFor("u1", JANE)).not.toBe(externalIdFor("u2", JANE));
    expect(externalIdFor("u1", JANE)).not.toBe(externalIdFor("u1", PERSONAS[1]));
  });
});

describe("Metriport sandbox through the real sync", () => {
  let db: Db;
  let userId: string;
  let keys: UserKeys;
  let sourceId: string;
  const clock = new Date("2026-10-08T12:00:00Z");

  beforeEach(async () => {
    clearBundleCache();
    db = await createTestDb();
    userId = await createTestUser(db, "metriport_user");
    keys = await userKeysFor(db, kek, userId, clock);
    ({ sourceId } = await saveMetriportConnection(db, tokenKey, { userId, persona: JANE, patientId: "mp-patient-1", facilityId: "facility-1" }, clock));
  });

  async function sync(client: MetriportClient) {
    const connection = (await getMetriportConnectionForSource(db, tokenKey, userId, sourceId))!;
    const { runId } = await startRun(db, { userId, sourceId, trigger: "manual" }, clock);
    const job = metriportJob({ db, keys, now: () => clock }, client, runId, userId, connection);
    const status = await runSyncJob({ runId, userId, sourceId }, (_id, work) => work(), {
      db,
      now: () => clock,
      load: async () => job,
      prepare: () => waitForRecords(client, connection.patientId, { sleep: async () => {} }),
    });
    const [run] = await db.select().from(syncRun).where(eq(syncRun.id, runId));
    return { status, run };
  }

  it("imports the bundle's records onto the timeline, each readable", async () => {
    const client = clientReturning([{ download: { status: "processing" } }, { download: { status: "completed" } }]);
    const { status } = await sync(client);
    expect(status).not.toBe("failed");
    expect(client.polls).toBe(2);
    // One bundle fetch for the whole job, not one per search.
    expect(client.fetches).toBe(1);

    const rows = await db.select().from(fhirResource).where(and(eq(fhirResource.sourceId, sourceId), isNull(fhirResource.supersededAt)));
    const byType = (type: string) => rows.filter((r) => r.resourceType === type).length;
    expect(byType("Condition")).toBe(30);
    expect(byType("Observation")).toBe(117 + 91 + 3);
    expect(byType("Encounter")).toBe(43);
    expect(byType("MedicationRequest")).toBe(12);
    expect(byType("AllergyIntolerance")).toBe(4);
    expect(byType("Immunization")).toBe(10);
    // What the records point to (clinicians, organizations, medications) is stored alongside, uncategorised.
    expect(byType("Practitioner")).toBeGreaterThan(0);

    const sources = await listSources(db, userId);
    expect(sources[0]).toMatchObject({ vendor: "metriport", status: "connected", lastSyncStatus: expect.stringMatching(/ok|partial/) });
    const { items } = await timelinePage(db, keys, userId, sources, { sourceIds: [], categories: [], from: null, to: null }, null, 100_000);
    expect(items.length).toBe(sources[0].recordCount);
    expect(items.length).toBeGreaterThan(300);
    for (const item of items) expect(describeResource(item as never)).toBeDefined();
  });

  it("is stable when synced again, and leaves note text out", async () => {
    const client = clientReturning([{ download: { status: "completed" } }]);
    await sync(client);
    const first = await db.select().from(fhirResource).where(eq(fhirResource.sourceId, sourceId));
    const { run } = await sync(client);
    const second = await db.select().from(fhirResource).where(eq(fhirResource.sourceId, sourceId));
    expect(second.length).toBe(first.length);
    expect(Object.values(run.stats).reduce((n, s) => n + s.inserted + s.superseded, 0)).toBe(0);
    expect(run.stats["Binary:note"]?.errorCode).toBe("not_granted");
  });

  it("fails the run, rather than importing nothing, when the pull from the networks failed", async () => {
    await expect(sync(clientReturning([{ download: { status: "failed" } }]))).rejects.toThrow(MetriportError);
    expect(await db.select().from(fhirResource).where(eq(fhirResource.sourceId, sourceId))).toEqual([]);
  });
});

describe("Metriport connections", () => {
  let db: Db;
  let userId: string;
  beforeEach(async () => {
    db = await createTestDb();
    userId = await createTestUser(db, "mp_conn_user");
  });

  it("seals the patient id, reuses the source when a persona is connected again, and keeps users apart", async () => {
    const now = new Date();
    const first = await saveMetriportConnection(db, tokenKey, { userId, persona: JANE, patientId: "mp-1", facilityId: "f" }, now);
    const again = await saveMetriportConnection(db, tokenKey, { userId, persona: JANE, patientId: "mp-1", facilityId: "f" }, now);
    expect(again.sourceId).toBe(first.sourceId);

    const [row] = await db.select().from(metriportConnection);
    expect(row.sealedPatientId).not.toContain("mp-1");
    expect((await findPersonaConnection(db, tokenKey, userId, JANE))?.patientId).toBe("mp-1");
    expect(await findPersonaConnection(db, tokenKey, userId, PERSONAS[1])).toBeUndefined();

    const other = await createTestUser(db, "mp_conn_other");
    expect(await findPersonaConnection(db, tokenKey, other, JANE)).toBeUndefined();
    expect(await getMetriportConnectionForSource(db, tokenKey, other, first.sourceId)).toBeUndefined();
  });

  it("disconnecting removes the link but keeps the source for its records", async () => {
    const { sourceId } = await saveMetriportConnection(db, tokenKey, { userId, persona: JANE, patientId: "mp-1", facilityId: "f" }, new Date());
    const [{ id }] = await db.select().from(metriportConnection);
    expect(await deleteMetriportConnection(db, userId, id)).toBe(true);
    expect(await getMetriportConnectionForSource(db, tokenKey, userId, sourceId)).toBeUndefined();
    const [source] = await db.select().from(healthSource).where(eq(healthSource.id, sourceId));
    expect(source.status).toBe("disconnected");
    expect(await deleteMetriportConnection(db, userId, id)).toBe(false);
  });
});
