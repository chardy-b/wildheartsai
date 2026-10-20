import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Operational metadata only: no user/source IDs, record counts, event payloads or errors.
// This is a system-wide scheduler heartbeat, not a table holding a person's data.
export const backgroundJobRun = pgTable("background_job_run", {
  id: text("id").primaryKey(),
  job: text("job", { enum: ["refresh_sources"] }).notNull(),
  status: text("status", { enum: ["running", "ok", "partial", "failed"] }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  due: integer("due").notNull().default(0),
  queued: integer("queued").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  failed: integer("failed").notNull().default(0),
}, (table) => [index("background_job_run_job_started_idx").on(table.job, table.startedAt.desc())]);
