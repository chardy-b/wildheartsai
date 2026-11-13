import { sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { AuditDetail, AuditInput } from "@/lib/audit";
import { auditEvent } from "../db/schema";
import type { UserScope } from "./scope";

// What happened to a person's records and connections (src/lib/audit.ts in the Next app): ids,
// counts and statuses only. Returns the statement, so callers can put it in the same batch as the
// action it records.
export function auditStatement(scope: UserScope, input: Omit<AuditInput, "userId" | "sourceId"> & { sourceId?: SQL | string | null }, now: Date) {
  return scope.insert(auditEvent, { userId: scope.userId, sourceId: input.sourceId ?? null, action: input.action, detail: input.detail ?? {}, createdAt: now });
}

// The same, recorded once per row of this person's that `where` selects in `table` (at most one,
// by id), at the moment the batch runs: the guard half of the audit's "guarded batch" pattern.
// `sourceId` and `detail` may read that row's columns.
export function auditFrom(
  scope: UserScope,
  table: Parameters<UserScope["selectFields"]>[0],
  where: SQL,
  input: { action: AuditInput["action"]; sourceId: SQLiteColumn | null; detail?: AuditDetail | SQL },
  now: Date,
) {
  const detail = input.detail === undefined || !("getSQL" in input.detail) ? sql`${JSON.stringify(input.detail ?? {})}` : (input.detail as SQL);
  const row = scope.selectFields(
    table,
    {
      id: sql<string>`${crypto.randomUUID()}`.as("id"),
      userId: sql<string>`${scope.userId}`.as("user_id"),
      sourceId: input.sourceId ? sql<string | null>`${input.sourceId}`.as("source_id") : sql<null>`null`.as("source_id"),
      action: sql<string>`${input.action}`.as("action"),
      detail: detail.as("detail"),
      createdAt: sql<number>`${now.getTime()}`.as("created_at"),
    },
    where,
  );
  return scope.insertSelect(auditEvent, row as never);
}
