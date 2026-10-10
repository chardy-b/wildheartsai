import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { healthSource, metriportConnection } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { deleteMetriportConnection } from "./connections";
import { PERSONAS } from "./personas";
import { connectSandboxPersona } from "./server";
import { loadSyncJob, prepareSyncJob, startSyncJob } from "@/lib/sync/server";

const state = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  key: undefined as Buffer | undefined,
  recordsKey: undefined as Buffer | undefined,
  client: {
    facilityId: vi.fn(), findPatient: vi.fn(), createPatient: vi.fn(),
    startDocumentQuery: vi.fn(), documentQueryStatus: vi.fn(), consolidated: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/epic/server", () => ({ tokenKey: () => state.key, accessTokenFor: vi.fn() }));
vi.mock("@/lib/records-keys", () => ({ recordsKey: () => state.recordsKey }));
vi.mock("@/lib/env", () => ({ env: () => ({ METRIPORT_API_KEY: "test-key" }) }));
vi.mock("./client", async (importOriginal) => ({
  ...await importOriginal<typeof import("./client")>(),
  createMetriportClient: () => state.client,
}));

describe("Metriport server wiring", () => {
  let db: Db;
  let userId: string;
  beforeEach(async () => {
    vi.resetAllMocks();
    db = state.db = await createTestDb();
    state.key = randomBytes(32);
    state.recordsKey = randomBytes(32);
    userId = await createTestUser(db);
    state.client.facilityId.mockResolvedValue("facility");
    state.client.createPatient.mockResolvedValue({ id: "sandbox-patient" });
    state.client.documentQueryStatus.mockResolvedValue({ download: { status: "completed" } });
  });

  it("saves before retrieval, dispatches refresh to Metriport, and stops after disconnect", async () => {
    const { sourceId } = await connectSandboxPersona(userId, PERSONAS[0]);
    expect(state.client.startDocumentQuery).not.toHaveBeenCalled();
    const request = { userId, sourceId, runId: "test-run" };
    expect((await loadSyncJob(request))?.source.sourceId).toBe(sourceId);
    await startSyncJob(request);
    await prepareSyncJob(request);
    expect(state.client.startDocumentQuery).toHaveBeenCalledWith("sandbox-patient", "facility");
    expect(state.client.documentQueryStatus).toHaveBeenCalledWith("sandbox-patient");

    const [connection] = await db.select().from(metriportConnection);
    await deleteMetriportConnection(db, userId, connection.id);
    expect(await loadSyncJob(request)).toBeUndefined();
    await startSyncJob(request);
    await prepareSyncJob(request);
    expect(state.client.startDocumentQuery).toHaveBeenCalledTimes(1);
    expect(state.client.documentQueryStatus).toHaveBeenCalledTimes(1);
  });

  it("reconnects to the same source and upstream patient after deleting the local link", async () => {
    const first = await connectSandboxPersona(userId, PERSONAS[0]);
    const [connection] = await db.select().from(metriportConnection);
    await deleteMetriportConnection(db, userId, connection.id);
    state.client.findPatient.mockResolvedValue({ id: "sandbox-patient" });
    expect(await connectSandboxPersona(userId, PERSONAS[0])).toEqual(first);
    expect(state.client.createPatient).toHaveBeenCalledTimes(1);
    const [source] = await db.select().from(healthSource).where(eq(healthSource.id, first.sourceId));
    expect(source.status).toBe("connected");
  });

  it("does not load or query another user's source", async () => {
    const { sourceId } = await connectSandboxPersona(userId, PERSONAS[0]);
    const other = await createTestUser(db, "other-user");
    const request = { userId: other, sourceId, runId: "test-run" };
    expect(await loadSyncJob(request)).toBeUndefined();
    await startSyncJob(request);
    await prepareSyncJob(request);
    expect(state.client.startDocumentQuery).not.toHaveBeenCalled();
    expect(state.client.documentQueryStatus).not.toHaveBeenCalled();
  });
});
