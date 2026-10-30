import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, now, time, uuidPk } from "../columns";
import { user } from "./auth";

export const profile = sqliteTable("profile", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  preferredName: text("preferred_name"),
  consentVersion: text("consent_version"),
  consentedAt: time("consented_at"),
  onboardedAt: time("onboarded_at"),
  createdAt: time("created_at").notNull().default(now),
  updatedAt: time("updated_at").notNull().default(now),
});

// What happened to a person's records and connections, and when. Never health data,
// organization names, tokens or patient identifiers: only ids, counts and statuses.
// No foreign keys, so the trail outlives the source (and account) it describes.
export const auditEvent = sqliteTable(
  "audit_event",
  {
    id: uuidPk(),
    userId: text("user_id").notNull(),
    sourceId: text("source_id"),
    action: text("action", { enum: ["connect", "reconnect", "disconnect", "delete_source", "sync", "export"] }).notNull(),
    detail: json<Record<string, string | number | boolean>>("detail").notNull().default({}),
    createdAt: time("created_at").notNull().default(now),
  },
  (table) => [index("audit_event_user_idx").on(table.userId, sql`${table.createdAt} desc`)],
);

// Operational metadata only: no user/source IDs, record counts, event payloads or errors.
// A system-wide scheduler heartbeat, not a table holding a person's data.
export const backgroundJobRun = sqliteTable(
  "background_job_run",
  {
    id: text("id").primaryKey(),
    job: text("job", { enum: ["refresh_sources"] }).notNull(),
    status: text("status", { enum: ["running", "ok", "partial", "failed"] }).notNull(),
    startedAt: time("started_at").notNull(),
    finishedAt: time("finished_at"),
    due: integer("due").notNull().default(0),
    queued: integer("queued").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
  },
  (table) => [index("background_job_run_job_started_idx").on(table.job, sql`${table.startedAt} desc`)],
);
