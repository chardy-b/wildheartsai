import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { healthSource, syncRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { saveConnection } from "@/lib/epic/connections";
import { createTestDb, createTestUser } from "@/test/db";
import { startRun } from "./run";
import { queueScheduledRefreshes, REFRESH_AFTER_MS, sourcesDueForRefresh } from "./scheduled";

const key = randomBytes(32);
const now = new Date("2026-09-27T10:17:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
let db: Db;
let userId: string;
let nextUser = 0;
let nextOrg = 0;

beforeEach(async () => {
  // A fresh database state per test: scheduling looks across every user.
  db = await createTestDb();
  userId = await createTestUser(db, `sched_user_${++nextUser}`);
});

async function source(state: Partial<typeof healthSource.$inferInsert>): Promise<string> {
  const url = `https://org${++nextOrg}.example/R4`;
  const { sourceId } = await saveConnection(
    db,
    key,
    { userId, fhirBaseUrl: url, organizationName: `Org ${nextOrg}`, tokenEndpoint: `${url}/token`, tokens: { accessToken: "at", refreshToken: "rt", expiresAt: now, scope: "s", patientId: "p" } },
    now,
  );
  await db.update(healthSource).set(state).where(eq(healthSource.id, sourceId));
  return sourceId;
}

describe("sourcesDueForRefresh", () => {
  it("picks connected sources not synced for most of a day, oldest first", async () => {
    const stale = await source({ lastSyncedAt: hoursAgo(30) });
    const never = await source({ lastSyncedAt: null });
    const older = await source({ lastSyncedAt: hoursAgo(50) });
    await source({ lastSyncedAt: hoursAgo(2) }); // fresh
    await source({ lastSyncedAt: new Date(now.getTime() - REFRESH_AFTER_MS + 60_000) }); // not yet due

    expect((await sourcesDueForRefresh(db, now)).map((s) => s.sourceId)).toEqual([never, older, stale]);
  });

  it("skips sources that need reconnecting, are disconnected, or are already syncing", async () => {
    await source({ lastSyncedAt: hoursAgo(30), status: "reconnect_required" });
    await source({ lastSyncedAt: hoursAgo(30), status: "disconnected" });
    const busy = await source({ lastSyncedAt: hoursAgo(30) });
    await startRun(db, { userId, sourceId: busy, trigger: "manual" }, now);
    expect(await sourcesDueForRefresh(db, now)).toEqual([]);
  });

  it("returns IDs only, and at most the batch size", async () => {
    await source({ lastSyncedAt: hoursAgo(30) });
    await source({ lastSyncedAt: hoursAgo(40) });
    const due = await sourcesDueForRefresh(db, now, 1);
    expect(due).toHaveLength(1);
    expect(Object.keys(due[0]).sort()).toEqual(["sourceId", "userId"]);
  });
});

describe("queueScheduledRefreshes", () => {
  it("queues a scheduled run per source and keeps going past a failure", async () => {
    const a = await source({ lastSyncedAt: hoursAgo(30) });
    const b = await source({ lastSyncedAt: hoursAgo(30) });
    const send = vi.fn(async ({ sourceId }: { sourceId: string }) => {
      if (sourceId === a) throw new Error("queue down");
    });
    const counts = await queueScheduledRefreshes(db, await sourcesDueForRefresh(db, now), send, now);
    expect(counts).toEqual({ queued: 1, skipped: 0, failed: 1 });

    const runs = await db.select().from(syncRun);
    expect(runs.find((r) => r.sourceId === b)).toMatchObject({ trigger: "scheduled", status: "queued" });
    // The run whose event couldn't be sent is closed, so it doesn't block the next night.
    expect(runs.find((r) => r.sourceId === a)?.status).toBe("failed");
  });

  it("isn't slowed by the manual refresh cooldown", async () => {
    const recent = await source({ lastSyncedAt: hoursAgo(21) });
    const counts = await queueScheduledRefreshes(db, [{ userId, sourceId: recent }], vi.fn(async () => {}), now);
    expect(counts.queued).toBe(1);
  });
});
