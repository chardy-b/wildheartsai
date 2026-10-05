import "server-only";
import { and, asc, eq, lte } from "drizzle-orm";
import { chatRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { ChatScope } from "./contracts";

// These functions must use only CHAT_QUEUE_DATABASE_URL, a separately provisioned role which
// has metadata-only grants on chat_run. Do not call them through the normal data gateway pool.
export type ClaimedRun = {
  scope: Required<Pick<ChatScope, "userId" | "conversationId" | "runId">> & { runAttempt: number; workerId: string };
  leaseExpiresAt: Date;
};

export async function claimNextQueuedRun(db: Db, input: { workerId: string; leaseMs: number; now?: Date }): Promise<ClaimedRun | undefined> {
  const now = input.now ?? new Date();
  if (!input.workerId || input.workerId.length > 200 || input.leaseMs < 1_000 || input.leaseMs > 10 * 60_000) throw new Error("Invalid queue lease");
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
  return db.transaction(async (tx) => {
    const [next] = await tx
      .select({ id: chatRun.id, userId: chatRun.userId, conversationId: chatRun.conversationId, attempt: chatRun.attempt })
      .from(chatRun)
      .where(and(eq(chatRun.status, "queued"), lte(chatRun.nextAttemptAt, now)))
      .orderBy(asc(chatRun.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!next) return undefined;
    const [claimed] = await tx
      .update(chatRun)
      .set({
        status: "running",
        leaseOwner: input.workerId,
        leaseExpiresAt,
        startedAt: now,
        attempt: next.attempt + 1,
        nextWorkerSequence: 0,
        updatedAt: now,
      })
      .where(and(eq(chatRun.id, next.id), eq(chatRun.status, "queued")))
      .returning({ id: chatRun.id, attempt: chatRun.attempt });
    if (!claimed) return undefined;
    return {
      scope: { userId: next.userId, conversationId: next.conversationId, runId: claimed.id, runAttempt: claimed.attempt, workerId: input.workerId },
      leaseExpiresAt,
    };
  }) as Promise<ClaimedRun | undefined>;
}

// The user chose visible interruption plus explicit retry after a crash. A recovered service may
// start queued work, but it never silently reruns a response that had begun.
export async function interruptExpiredRuns(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .update(chatRun)
    .set({ status: "interrupted", leaseOwner: null, leaseExpiresAt: null, completedAt: now, updatedAt: now })
    .where(and(eq(chatRun.status, "running"), lte(chatRun.leaseExpiresAt, now)))
    .returning({ id: chatRun.id });
  return rows.length;
}
