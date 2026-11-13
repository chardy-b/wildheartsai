import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { disconnect, getConnectionForSource, saveConnection } from "../src/data/connections";
import { deleteSource, listSources } from "../src/data/sources";
import { failRun, requestSync, startRun } from "../src/data/sync-runs";
import * as s from "../src/db/schema";
import { clearAll, db, person, tokenKey, tokens } from "./helpers";

const URL_A = "https://fhir.example.test/a/api/FHIR/R4";
const at = new Date("2026-11-01T12:00:00.000Z");

beforeEach(clearAll);

async function connected(userId: string) {
  const scope = await person(userId);
  const { sourceId } = await saveConnection(scope, tokenKey, { fhirBaseUrl: URL_A, organizationName: "Example Health", tokenEndpoint: "https://fhir.example.test/token", tokens: tokens("access-1", "refresh-1", 3600_000) }, at);
  return { scope, sourceId };
}

const audits = async (userId: string) => (await db.select().from(s.auditEvent).where(eq(s.auditEvent.userId, userId))).map((a) => a.action).sort();

describe("connections on D1", () => {
  it("saves a source, its sealed tokens and an audit row in one batch, and reuses the source on reconnect", async () => {
    const { scope, sourceId } = await connected("a");
    const connection = await getConnectionForSource(scope, tokenKey, sourceId);
    expect(connection).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", patientId: "made-up-patient", fhirBaseUrl: URL_A });
    const [row] = await db.select().from(s.epicConnection);
    expect(row.sealedAccessToken).not.toContain("access-1");

    await disconnect(scope, connection!.id, at);
    const again = await saveConnection(scope, tokenKey, { fhirBaseUrl: URL_A, organizationName: "Example Health", tokenEndpoint: "https://fhir.example.test/token", tokens: tokens("access-2", "refresh-2", 3600_000) }, at);
    expect(again.sourceId).toBe(sourceId);
    expect((await getConnectionForSource(scope, tokenKey, sourceId))?.accessToken).toBe("access-2");
    expect((await db.select().from(s.healthSource))[0].status).toBe("connected");
    expect(await audits("a")).toEqual(["connect", "disconnect", "reconnect"]);
  });

  it("disconnects only the person's own connection, and audits only what happened", async () => {
    const a = await connected("a");
    const b = await person("b");
    const connectionId = (await getConnectionForSource(a.scope, tokenKey, a.sourceId))!.id;
    expect(await disconnect(b, connectionId, at)).toBe(false);
    expect(await db.select().from(s.epicConnection)).toHaveLength(1);
    expect(await audits("b")).toEqual([]);
    expect((await db.select().from(s.healthSource))[0].status).toBe("connected");

    expect(await disconnect(a.scope, connectionId, at)).toBe(true);
    expect(await disconnect(a.scope, connectionId, at)).toBe(false);
    expect(await audits("a")).toEqual(["connect", "disconnect"]);
    // The records' source stays, marked disconnected.
    expect((await db.select().from(s.healthSource))[0].status).toBe("disconnected");
  });

  it("deletes only the person's own source, auditing once", async () => {
    const a = await connected("a");
    const b = await person("b");
    expect(await deleteSource(b, a.sourceId, at)).toBe(false);
    expect(await audits("b")).toEqual([]);
    expect(await deleteSource(a.scope, a.sourceId, at)).toBe(true);
    expect(await deleteSource(a.scope, a.sourceId, at)).toBe(false);
    expect(await db.select().from(s.epicConnection)).toEqual([]);
    expect(await audits("a")).toEqual(["connect", "delete_source"]);
  });
});

describe("sync runs on D1", () => {
  it("queues one run per source, and ends lost runs", async () => {
    const { scope, sourceId } = await connected("a");
    const first = await startRun(scope, { sourceId, trigger: "manual" }, at);
    expect(first.created).toBe(true);
    expect(await startRun(scope, { sourceId, trigger: "manual" }, at)).toEqual({ runId: first.runId, created: false });
    // Four hours later the queued run is stale: it's failed and a new one starts.
    const later = await startRun(scope, { sourceId, trigger: "scheduled" }, new Date(at.getTime() + 4 * 3600_000));
    expect(later.created).toBe(true);
    expect((await db.select().from(s.syncRun).where(eq(s.syncRun.id, first.runId)))[0].status).toBe("failed");
  });

  it("requests a sync with the same outcomes as the Next app", async () => {
    const { scope, sourceId } = await connected("a");
    const sent: unknown[] = [];
    const send = async (r: unknown) => void sent.push(r);
    expect(await requestSync(scope, { sourceId, trigger: "connect" }, send, at)).toBe("queued");
    expect(sent).toEqual([expect.objectContaining({ userId: "a", sourceId })]);
    expect(await requestSync(scope, { sourceId, trigger: "manual" }, send, at)).toBe("already_running");
    expect(await requestSync(await person("b"), { sourceId, trigger: "manual" }, send, at)).toBe("not_connected");
    await db.update(s.syncRun).set({ status: "ok" });
    await db.update(s.healthSource).set({ lastSyncedAt: at });
    expect(await requestSync(scope, { sourceId, trigger: "manual" }, send, new Date(at.getTime() + 60_000))).toBe("cooldown");
  });

  it("fails a run whose queueing failed, once, recording why", async () => {
    const { scope, sourceId } = await connected("a");
    await expect(requestSync(scope, { sourceId, trigger: "manual" }, async () => { throw new Error("queue down"); }, at)).rejects.toThrow("queue down");
    const [run] = await db.select().from(s.syncRun);
    expect(run.status).toBe("failed");
    await failRun(scope, run.id, "error", at);
    const syncs = (await db.select().from(s.auditEvent)).filter((e) => e.action === "sync");
    expect(syncs).toHaveLength(1);
    expect(syncs[0].detail).toEqual({ trigger: "manual", status: "failed", reason: "error" });
    expect((await db.select().from(s.healthSource))[0].lastSyncStatus).toBe("failed");
  });

  it("marks the source for reconnecting, with the failure diagnostic", async () => {
    const { scope, sourceId } = await connected("a");
    const { runId } = await startRun(scope, { sourceId, trigger: "connect" }, at);
    await failRun(scope, runId, "reconnect", at, { failureStage: "refresh", failureCode: "refresh_rejected", httpStatus: 400 });
    expect((await db.select().from(s.healthSource))[0].status).toBe("reconnect_required");
    const sync = (await db.select().from(s.auditEvent)).find((e) => e.action === "sync");
    expect(sync?.detail).toEqual({ trigger: "connect", status: "failed", reason: "reconnect", failureStage: "refresh", failureCode: "refresh_rejected", httpStatus: 400 });
  });

  it("lists sources with their sync state and counts", async () => {
    const { scope, sourceId } = await connected("a");
    await db.insert(s.syncRun).values([
      { id: "old", userId: "a", sourceId, trigger: "manual", status: "failed", stats: { q: { fetched: 1, inserted: 0, superseded: 0, unchanged: 0, removed: 0, errorCode: "500" } }, queuedAt: new Date(at.getTime() - 60_000) },
      { id: "new", userId: "a", sourceId, trigger: "manual", status: "ok", stats: { q: { fetched: 2, inserted: 2, superseded: 0, unchanged: 0, removed: 0 } }, queuedAt: at },
    ]);
    const [source] = await listSources(scope, at);
    expect(source).toMatchObject({ id: sourceId, status: "connected", syncing: false, recordCount: 0, grantedScope: expect.stringContaining("Observation") });
    expect(source.lastRunStats).toEqual({ q: { fetched: 2, inserted: 2, superseded: 0, unchanged: 0, removed: 0 } });
    expect(await listSources(await person("b"), at)).toEqual([]);
  });
});
