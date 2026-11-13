import { createScheduledController, env, introspectWorkflowInstance } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EPIC_SANDBOX } from "@/lib/epic/directory";
import type { MetriportClient } from "@/lib/metriport/client";
import { PERSONAS } from "@/lib/metriport/personas";
import { saveConnection } from "../src/data/connections";
import { saveMetriportConnection } from "../src/data/metriport";
import { requestSync, type SyncRequest } from "../src/data/sync-runs";
import * as s from "../src/db/schema";
import type { Bindings } from "../src/env";
import worker, { CRONS } from "../src/index";
import { runSyncJob } from "../src/jobs/sync/job";
import { syncJobEnv } from "../src/jobs/sync/load";
import { clearBundleCache } from "../src/jobs/sync/metriport";
import { sendTo } from "../src/sync-queue";
import { clearAll, db, person, tokenKey, tokens } from "./helpers";

// The background jobs as Workflows: a sync started the way the API starts it, the nightly
// refresh, the crons, and a Metriport source through the same job.
const bindings = env as unknown as Bindings;
const TOKEN = "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token";
const observation = { resourceType: "Observation", id: "obs-1", status: "final", category: [{ coding: [{ code: "laboratory" }] }], code: { text: "Made-up test" }, effectiveDateTime: "2026-01-01T00:00:00Z", valueQuantity: { value: 1, unit: "mg/dL" } };

let refreshRejected = false;
beforeEach(async () => {
  await clearAll();
  refreshRejected = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === TOKEN) return refreshRejected ? Response.json({ error: "invalid_grant" }, { status: 400 }) : new Response("unexpected", { status: 500 });
    if (url.startsWith(EPIC_SANDBOX.fhirBaseUrl)) {
      const lab = url.includes("Observation?") && url.includes("laboratory");
      return Response.json({ resourceType: "Bundle", entry: lab ? [{ resource: observation }] : [] });
    }
    return new Response("unexpected", { status: 500 });
  });
});
afterEach(() => vi.restoreAllMocks());

async function connectedSandbox(userId: string, expiresInMs: number) {
  const scope = await person(userId);
  const { sourceId } = await saveConnection(scope, tokenKey, { fhirBaseUrl: EPIC_SANDBOX.fhirBaseUrl, organizationName: "Sandbox", tokenEndpoint: TOKEN, tokens: tokens("access", "refresh", expiresInMs) }, new Date());
  return { scope, sourceId };
}

// Starts a sync as the API does and returns the Workflow instance to watch.
async function startSync(scope: Awaited<ReturnType<typeof person>>, sourceId: string) {
  let instance: Awaited<ReturnType<typeof introspectWorkflowInstance>> | undefined;
  const outcome = await requestSync(scope, { sourceId, trigger: "manual" }, async (request: SyncRequest) => {
    instance = await introspectWorkflowInstance(bindings.SYNC_WORKFLOW, request.runId);
    await sendTo(bindings)(request);
  }, new Date());
  expect(outcome).toBe("queued");
  return instance!;
}

describe("sync Workflow", () => {
  it("imports a source end to end and finishes the run", async () => {
    const { scope, sourceId } = await connectedSandbox("a", 3600_000);
    await using instance = await startSync(scope, sourceId);
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toBe("ok");
    const [run] = await db.select().from(s.syncRun);
    expect(run.status).toBe("ok");
    expect(await db.select({ fhirId: s.fhirResource.fhirId }).from(s.fhirResource)).toEqual([{ fhirId: "obs-1" }]);
    const [source] = await db.select().from(s.healthSource).where(eq(s.healthSource.id, sourceId));
    expect(source).toMatchObject({ lastSyncStatus: "ok", status: "connected" });
    expect((await db.select().from(s.auditEvent)).filter((e) => e.action === "sync")).toEqual([expect.objectContaining({ detail: expect.objectContaining({ status: "ok", trigger: "manual", inserted: 1 }) })]);
  });

  it("ends the run and asks for a reconnect when Epic rejects the refresh", async () => {
    refreshRejected = true;
    const { scope, sourceId } = await connectedSandbox("a", -60_000);
    await using instance = await startSync(scope, sourceId);
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toBe("failed");
    const [source] = await db.select().from(s.healthSource).where(eq(s.healthSource.id, sourceId));
    expect(source).toMatchObject({ status: "reconnect_required", lastSyncStatus: "failed" });
    const [run] = await db.select().from(s.syncRun);
    expect(run.status).toBe("failed");
  });
});

describe("nightly refresh", () => {
  it("queues a scheduled sync for every due source and records the schedule", async () => {
    const a = await connectedSandbox("a", 3600_000);
    const b = await connectedSandbox("b", 3600_000);
    // Synced an hour ago: not due.
    await db.update(s.healthSource).set({ lastSyncedAt: new Date(Date.now() - 3600_000) }).where(eq(s.healthSource.id, b.sourceId));
    await using instance = await introspectWorkflowInstance(bindings.REFRESH_WORKFLOW, "refresh-test");
    await instance.modify(async (m) => {
      await m.disableSleeps();
    });
    await bindings.REFRESH_WORKFLOW.create({ id: "refresh-test" });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ due: 1, queued: 1, skipped: 0, failed: 0 });
    const runs = await db.select().from(s.syncRun);
    expect(runs).toEqual([expect.objectContaining({ sourceId: a.sourceId, trigger: "scheduled", userId: "a" })]);
    expect(await db.select().from(s.backgroundJobRun)).toEqual([expect.objectContaining({ id: "refresh-test", status: "ok", due: 1, queued: 1 })]);
  });

  it("starts each day's job once from its cron", async () => {
    const create = vi.spyOn(bindings.REFRESH_WORKFLOW, "create");
    const scheduledTime = Date.parse("2026-11-13T10:17:00Z");
    for (let i = 0; i < 2; i++) {
      await worker.scheduled(createScheduledController({ scheduledTime, cron: CRONS.refreshSources }), bindings);
    }
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.every(([options]) => options?.id === "refresh-sources-2026-11-13")).toBe(true);
    expect((await bindings.REFRESH_WORKFLOW.get("refresh-sources-2026-11-13")).id).toBe("refresh-sources-2026-11-13");
  });
});

describe("Metriport sources", () => {
  it("start the pull, wait for it, and import from the consolidated bundle", async () => {
    clearBundleCache();
    const scope = await person("a");
    const persona = PERSONAS[0];
    const { sourceId } = await saveMetriportConnection(scope, tokenKey, { persona, patientId: "made-up-patient", facilityId: "facility" }, new Date());
    let statusChecks = 0;
    const client = {
      startDocumentQuery: vi.fn(async () => ({})),
      documentQueryStatus: vi.fn(async () => (++statusChecks < 2 ? { download: { status: "processing" } } : { download: { status: "completed" }, convert: { status: "completed" } })),
      consolidated: vi.fn(async () => ({ resourceType: "Bundle", entry: [{ resource: { ...observation, subject: { reference: "Patient/made-up-patient" } } }] })),
    } as unknown as MetriportClient;
    const { runId } = await (await import("../src/data/sync-runs")).startRun(scope, { sourceId, trigger: "connect" }, new Date());
    const status = await runSyncJob({ runId, userId: "a", sourceId }, (_id, work) => work(), syncJobEnv(bindings, scope, () => client));
    expect(status).not.toBe("failed");
    expect(client.startDocumentQuery).toHaveBeenCalledWith("made-up-patient", "facility");
    expect(statusChecks).toBe(2);
    // One bundle fetch, shared by every search step of the run.
    expect(client.consolidated).toHaveBeenCalledTimes(1);
    expect(await db.select({ fhirId: s.fhirResource.fhirId }).from(s.fhirResource)).toEqual([{ fhirId: "obs-1" }]);
  });
});
