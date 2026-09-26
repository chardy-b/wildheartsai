import { and, eq } from "drizzle-orm";
import { healthSource } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { SyncRequest } from "./job";
import { failRun, startRun, type SyncTrigger } from "./run";

// Manual refreshes of one source are at most this frequent.
export const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

export type RequestOutcome = "queued" | "already_running" | "cooldown" | "not_connected";

// Queues a sync of one of the person's sources and hands its IDs to the job queue.
export async function requestSync(
  db: Db,
  input: { userId: string; sourceId: string; trigger: SyncTrigger },
  send: (request: SyncRequest) => Promise<void>,
  now: Date,
): Promise<RequestOutcome> {
  const [source] = await db
    .select({ status: healthSource.status, lastSyncedAt: healthSource.lastSyncedAt })
    .from(healthSource)
    .where(and(eq(healthSource.id, input.sourceId), eq(healthSource.userId, input.userId)))
    .limit(1);
  if (source?.status !== "connected") return "not_connected";
  if (input.trigger === "manual" && source.lastSyncedAt && now.getTime() - source.lastSyncedAt.getTime() < REFRESH_COOLDOWN_MS) {
    return "cooldown";
  }

  const { runId, created } = await startRun(db, input, now);
  if (!created) return "already_running";
  try {
    await send({ runId, userId: input.userId, sourceId: input.sourceId });
  } catch (error) {
    // Otherwise the queued run would block this source until it went stale.
    await failRun(db, runId, "error", now);
    throw error;
  }
  return "queued";
}
