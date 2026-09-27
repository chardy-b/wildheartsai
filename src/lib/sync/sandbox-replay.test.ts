import { requestedScopes } from "@/lib/epic/authorize";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { userKeysFor, type UserKeys } from "@/lib/crypto/user-keys";
import { fhirResource, healthSource, syncRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { describeResource } from "@/lib/fhir/describe";
import { fieldTree } from "@/lib/fhir/fields";
import { noteAttachment } from "@/lib/fhir/links";
import { referenceKey } from "@/lib/fhir/references";
import { listSources } from "@/lib/sources";
import { timelinePage } from "@/lib/timeline";
import { loadFixtures, recordedResults, replayEpic, type SandboxFixture } from "@/test/epic-replay";
import { createTestDb, createTestUser } from "@/test/db";
import { runSyncJob } from "./job";
import { storedNoteText } from "./notes";
import { startRun, type SyncDeps } from "./run";

// Every scope the app can ask for, as a fully granted connection would have.
const ALL_SCOPES = requestedScopes(true).join(" ");

// The real sync, end to end, over recorded Epic sandbox data (src/test/fixtures/epic-sandbox).
// Record fresh data with `npm run qa:capture`; see AGENTS.md.

const kek = randomBytes(32);
const ALL = { sourceIds: [], categories: [], from: null, to: null };
let db: Db;
let userId: string;
let keys: UserKeys;
let sourceId: string;
let clock: Date;

async function sync(fixture: SandboxFixture, replay: ReturnType<typeof replayEpic>) {
  const { runId } = await startRun(db, { userId, sourceId, trigger: "manual" }, clock);
  const deps: SyncDeps = { db, keys, now: () => clock, accessToken: async () => "token", search: replay.search, read: replay.read };
  const source = { runId, userId, sourceId, organizationName: "Epic sandbox", fhirBaseUrl: fixture.fhirBaseUrl, patientId: fixture.patientId, scope: ALL_SCOPES };
  const status = await runSyncJob({ runId, userId, sourceId }, (_id, work) => work(), { db, now: () => clock, load: async () => ({ deps, source }) });
  const [run] = await db.select().from(syncRun).where(eq(syncRun.id, runId));
  return { status, run };
}

describe.each(loadFixtures())("recorded sandbox: $name", ({ fixture }) => {
  beforeEach(async () => {
    db = await createTestDb();
    userId = await createTestUser(db, "sandbox_user");
    keys = await userKeysFor(db, kek, userId, new Date());
    const [source] = await db
      .insert(healthSource)
      .values({ userId, vendor: "epic", fhirBaseUrl: fixture.fhirBaseUrl, organizationName: "Epic sandbox", status: "connected" })
      .returning({ id: healthSource.id });
    sourceId = source.id;
    clock = new Date(Date.parse(fixture.capturedAt) + 60_000);
  });

  it("stores every resource the searches returned, once", async () => {
    const { status } = await sync(fixture, replayEpic(fixture));
    expect(status).not.toBe("failed");

    const rows = await db.select().from(fhirResource).where(and(eq(fhirResource.sourceId, sourceId), isNull(fhirResource.supersededAt)));
    const expected = new Set(
      Object.values(recordedResults(fixture))
        .flat()
        .filter((r) => r.id)
        .map((r) => `${r.resourceType}/${r.id}`),
    );
    // Plus each clinician, place, organization and medication the records point to that the sandbox served.
    for (const address of Object.keys(fixture.reads)) {
      const served = fixture.reads[address];
      if (referenceKey(address) && !("error" in served)) expected.add(address);
    }
    expect(new Set(rows.map((r) => `${r.resourceType}/${r.fhirId}`))).toEqual(expected);
  });

  it("shows every stored record on the timeline, with readable details for each", async () => {
    await sync(fixture, replayEpic(fixture));
    const sources = await listSources(db, userId);
    const { items } = await timelinePage(db, keys, userId, sources, ALL, null, 100_000);
    expect(items.length).toBe(sources[0].recordCount);
    for (const item of items) {
      expect(item.title).toBeTruthy();
      expect(() => describeResource(item.resource)).not.toThrow();
      expect(() => fieldTree(item.resource as Record<string, unknown>)).not.toThrow();
    }
  });

  it("stores the text of every note the sandbox served", async () => {
    await sync(fixture, replayEpic(fixture));
    for (const note of recordedResults(fixture)["DocumentReference:note"] ?? []) {
      const attachment = noteAttachment(note);
      const served = attachment ? fixture.reads[attachment.url] : undefined;
      if (!attachment || !served || "error" in served) continue;
      expect(await storedNoteText(db, keys, userId, sourceId, attachment.url)).not.toBeUndefined();
    }
  });

  it("changes nothing when synced again with nothing new", async () => {
    await sync(fixture, replayEpic(fixture, { lastUpdated: "ignore" }));
    clock = new Date(clock.getTime() + 3_600_000);
    const replay = replayEpic(fixture, { lastUpdated: "ignore" });
    const { run } = await sync(fixture, replay);
    for (const stats of Object.values(run.stats)) {
      expect(stats).toMatchObject({ inserted: 0, superseded: 0, removed: 0 });
    }
    expect(replay.reads).toEqual([]);
  });

  it("keeps record content out of the sync stats", async () => {
    const { run } = await sync(fixture, replayEpic(fixture));
    const stats = JSON.stringify(run.stats);
    for (const resource of Object.values(recordedResults(fixture)).flat()) {
      const text = (resource as { code?: { text?: string } }).code?.text;
      if (text && text.length > 3) expect(stats).not.toContain(text);
    }
    expect(stats).not.toContain(fixture.patientId);
  });
});
