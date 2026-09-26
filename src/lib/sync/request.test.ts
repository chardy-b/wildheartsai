import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { healthSource, syncRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { saveConnection } from "@/lib/epic/connections";
import { createTestDb, createTestUser } from "@/test/db";
import { runSyncJob, type SyncRequest } from "./job";
import { REFRESH_COOLDOWN_MS, requestSync } from "./request";

const key = randomBytes(32);
const now = new Date("2026-09-26T12:00:00Z");
let db: Db;
let userId: string;
let sourceId: string;
let nextUser = 0;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  userId = await createTestUser(db, `request_user_${++nextUser}`);
  ({ sourceId } = await saveConnection(
    db,
    key,
    {
      userId,
      fhirBaseUrl: "https://fhir.example.org/R4",
      organizationName: "Example Health",
      tokenEndpoint: "https://fhir.example.org/token",
      tokens: { accessToken: "at", refreshToken: "rt", expiresAt: now, scope: "s", patientId: "p1" },
    },
    now,
  ));
});

const runs = () => db.select().from(syncRun).where(eq(syncRun.sourceId, sourceId));

describe("requestSync", () => {
  it("queues a run and sends only its IDs to the queue", async () => {
    const send = vi.fn<(request: SyncRequest) => Promise<void>>(async () => {});
    expect(await requestSync(db, { userId, sourceId, trigger: "connect" }, send, now)).toBe("queued");
    const [run] = await runs();
    expect(send).toHaveBeenCalledWith({ runId: run.id, userId, sourceId });
    expect(Object.keys(send.mock.calls[0][0]).sort()).toEqual(["runId", "sourceId", "userId"]);
  });

  it("doesn't queue a second run while one is active", async () => {
    const send = vi.fn(async () => {});
    await requestSync(db, { userId, sourceId, trigger: "connect" }, send, now);
    expect(await requestSync(db, { userId, sourceId, trigger: "manual" }, send, now)).toBe("already_running");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("limits manual refreshes to one every few minutes", async () => {
    const send = vi.fn(async () => {});
    await db.update(healthSource).set({ lastSyncedAt: now }).where(eq(healthSource.id, sourceId));
    const soon = new Date(now.getTime() + REFRESH_COOLDOWN_MS - 1000);
    expect(await requestSync(db, { userId, sourceId, trigger: "manual" }, send, soon)).toBe("cooldown");
    const later = new Date(now.getTime() + REFRESH_COOLDOWN_MS);
    expect(await requestSync(db, { userId, sourceId, trigger: "manual" }, send, later)).toBe("queued");
  });

  it("refuses sources that aren't connected, or aren't the person's", async () => {
    const send = vi.fn(async () => {});
    const other = await createTestUser(db, `request_user_${++nextUser}`);
    expect(await requestSync(db, { userId: other, sourceId, trigger: "manual" }, send, now)).toBe("not_connected");
    await db.update(healthSource).set({ status: "reconnect_required" }).where(eq(healthSource.id, sourceId));
    expect(await requestSync(db, { userId, sourceId, trigger: "manual" }, send, now)).toBe("not_connected");
    expect(send).not.toHaveBeenCalled();
  });

  it("ends the run if the queue can't be reached, so the source isn't blocked", async () => {
    const send = vi.fn(async () => {
      throw new Error("queue down");
    });
    await expect(requestSync(db, { userId, sourceId, trigger: "manual" }, send, now)).rejects.toThrow("queue down");
    const [run] = await runs();
    expect(run.status).toBe("failed");
    expect(await requestSync(db, { userId, sourceId, trigger: "manual" }, vi.fn(async () => {}), now)).toBe("queued");
  });
});

describe("runSyncJob", () => {
  it("fails the run cleanly when the source was disconnected before it ran", async () => {
    await requestSync(db, { userId, sourceId, trigger: "manual" }, async () => {}, now);
    const [run] = await runs();
    const steps: string[] = [];
    const status = await runSyncJob(
      { runId: run.id, userId, sourceId },
      (id, work) => {
        steps.push(id);
        return work();
      },
      { db, now: () => now, load: async () => undefined },
    );
    expect(status).toBe("failed");
    expect(steps).toEqual(["begin"]);
    expect((await runs())[0].status).toBe("failed");
  });
});
