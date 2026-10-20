import { eq } from "drizzle-orm";
import { backgroundJobRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

export type ScheduleTotals = { due: number; queued: number; skipped: number; failed: number };

export async function beginSchedule(db: Db, id: string, now: Date): Promise<void> {
  await db.insert(backgroundJobRun).values({ id, job: "refresh_sources", status: "running", startedAt: now }).onConflictDoNothing();
}

export async function finishSchedule(db: Db, id: string, totals: ScheduleTotals, now: Date): Promise<void> {
  await db.update(backgroundJobRun).set({ ...totals, status: totals.failed ? "partial" : "ok", finishedAt: now }).where(eq(backgroundJobRun.id, id));
}

export async function failSchedule(db: Db, id: string, now: Date): Promise<void> {
  await db.update(backgroundJobRun).set({ status: "failed", finishedAt: now }).where(eq(backgroundJobRun.id, id));
}
