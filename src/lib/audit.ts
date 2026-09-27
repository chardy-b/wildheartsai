import { auditEvent } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

export type AuditAction = (typeof auditEvent.$inferInsert)["action"];

// Detail is limited to ids, counts, statuses and flags; the type keeps free text
// (record content, organization names) from being passed by accident.
export type AuditDetail = Record<string, number | boolean | AuditWord>;
// A status or trigger name: lowercase letters and underscores.
type AuditWord = "connect" | "manual" | "scheduled" | "ok" | "partial" | "failed" | "reconnect" | "error";

export type AuditInput = { userId: string; sourceId?: string | null; action: AuditAction; detail?: AuditDetail };

// Pass the transaction the action runs in, so the event is recorded exactly when the action is.
export async function recordAudit(db: Pick<Db, "insert">, input: AuditInput, now: Date): Promise<void> {
  await db.insert(auditEvent).values({ userId: input.userId, sourceId: input.sourceId ?? null, action: input.action, detail: input.detail ?? {}, createdAt: now });
}
