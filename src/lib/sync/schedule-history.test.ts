import { describe, expect, it } from "vitest";
import { backgroundJobRun } from "@/lib/db/schema";
import { createTestDb } from "@/test/db";
import { beginSchedule, failSchedule, finishSchedule } from "./schedule-history";

describe("durable scheduler history", () => {
  it("records starts, survives duplicate delivery, and finishes with queue totals only", async () => {
    const db = await createTestDb();
    const now = new Date("2026-10-19T10:17:00Z");
    await beginSchedule(db, "schedule-1", now);
    await beginSchedule(db, "schedule-1", new Date(now.getTime() + 1000));
    await finishSchedule(db, "schedule-1", { due: 3, queued: 2, skipped: 1, failed: 0 }, new Date(now.getTime() + 2000));
    const rows = await db.select().from(backgroundJobRun);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ startedAt: now, status: "ok", due: 3, queued: 2, skipped: 1, failed: 0 });
    expect(Object.keys(rows[0]).sort()).toEqual(["due", "failed", "finishedAt", "id", "job", "queued", "skipped", "startedAt", "status"]);
  });

  it("distinguishes queue failures from an interrupted scheduler", async () => {
    const db = await createTestDb();
    const now = new Date();
    await beginSchedule(db, "partial", now);
    await finishSchedule(db, "partial", { due: 2, queued: 1, skipped: 0, failed: 1 }, now);
    await beginSchedule(db, "failed", now);
    await failSchedule(db, "failed", now);
    expect((await db.select().from(backgroundJobRun)).map((row) => row.status).sort()).toEqual(["failed", "partial"]);
  });
});
