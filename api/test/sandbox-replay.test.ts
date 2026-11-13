import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { requestedScopes } from "@/lib/epic/authorize";
import { describeResource } from "@/lib/fhir/describe";
import { fieldTree } from "@/lib/fhir/fields";
import { noteAttachment } from "@/lib/fhir/links";
import { referenceKey } from "@/lib/fhir/references";
import { recordedResults, replayEpic, type SandboxFixture } from "@/test/epic-replay";
import type { UserKeys } from "../src/crypto/fields";
import { storedNoteText, timelinePage } from "../src/data/records";
import type { UserScope } from "../src/data/scope";
import { listSources } from "../src/data/sources";
import { startRun } from "../src/data/sync-runs";
import { userKeysFor } from "../src/data/user-keys";
import * as s from "../src/db/schema";
import { runSyncJob } from "../src/jobs/sync/job";
import type { SyncDeps } from "../src/jobs/sync/run";
import { clearAll, db, person, recordsKey } from "./helpers";

// Ported from src/lib/sync/sandbox-replay.test.ts: the real sync, end to end, over the recorded
// Epic sandbox data (src/test/fixtures/epic-sandbox), now writing to D1. The same fixtures and
// assertions, so a recapture tests both stacks.
const fixtures = Object.entries(import.meta.glob<SandboxFixture>("../../src/test/fixtures/epic-sandbox/*.json", { eager: true, import: "default" })).map(
  ([file, fixture]) => ({ name: file.split("/").pop()!.replace(/\.json$/, ""), fixture }),
);
const ALL_SCOPES = requestedScopes(true).join(" ");
const ALL = { sourceIds: [], categories: [], from: null, to: null };

let scope: UserScope;
let keys: UserKeys;
let sourceId: string;
let clock: Date;

async function sync(fixture: SandboxFixture, replay: ReturnType<typeof replayEpic>) {
  const { runId } = await startRun(scope, { sourceId, trigger: "manual" }, clock);
  const deps: SyncDeps = { scope, keys, now: () => clock, accessToken: async () => "token", search: replay.search, read: replay.read };
  const source = { runId, userId: scope.userId, sourceId, organizationName: "Epic sandbox", fhirBaseUrl: fixture.fhirBaseUrl, patientId: fixture.patientId, scope: ALL_SCOPES };
  const status = await runSyncJob({ runId, userId: scope.userId, sourceId }, (_id, work) => work(), { scope, now: () => clock, load: async () => ({ deps, source }) });
  const [run] = await db.select().from(s.syncRun).where(eq(s.syncRun.id, runId));
  return { status, run };
}

it("has recorded fixtures to replay", () => {
  expect(fixtures.map((f) => f.name)).toContain("handmade-example");
});

describe.each(fixtures)("recorded sandbox on D1: $name", ({ fixture }) => {
  beforeEach(async () => {
    await clearAll();
    scope = await person("sandbox-user");
    keys = await userKeysFor(scope, recordsKey, new Date());
    sourceId = crypto.randomUUID();
    await db.insert(s.healthSource).values({ id: sourceId, userId: "sandbox-user", vendor: "epic", fhirBaseUrl: fixture.fhirBaseUrl, organizationName: "Epic sandbox", status: "connected" });
    clock = new Date(Date.parse(fixture.capturedAt) + 60_000);
  });

  it("stores every resource the searches returned, once", async () => {
    const { status } = await sync(fixture, replayEpic(fixture));
    expect(status).not.toBe("failed");
    const rows = await db.select().from(s.fhirResource).where(and(eq(s.fhirResource.sourceId, sourceId), isNull(s.fhirResource.supersededAt)));
    const expected = new Set(Object.values(recordedResults(fixture)).flat().filter((r) => r.id).map((r) => `${r.resourceType}/${r.id}`));
    for (const address of Object.keys(fixture.reads)) {
      const served = fixture.reads[address];
      if (referenceKey(address) && !("error" in served)) expected.add(address);
    }
    expect(new Set(rows.map((r) => `${r.resourceType}/${r.fhirId}`))).toEqual(expected);
  });

  it("shows every stored record on the timeline, with readable details for each", async () => {
    await sync(fixture, replayEpic(fixture));
    const sources = await listSources(scope);
    const { items } = await timelinePage(scope, keys, sources, ALL, null, 100_000);
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
      expect(await storedNoteText(scope, keys, sourceId, attachment.url)).not.toBeUndefined();
    }
  });

  it("changes nothing when synced again with nothing new", async () => {
    await sync(fixture, replayEpic(fixture, { lastUpdated: "ignore" }));
    clock = new Date(clock.getTime() + 3_600_000);
    const replay = replayEpic(fixture, { lastUpdated: "ignore" });
    const { run } = await sync(fixture, replay);
    for (const stats of Object.values(run.stats)) expect(stats).toMatchObject({ inserted: 0, superseded: 0, removed: 0 });
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
