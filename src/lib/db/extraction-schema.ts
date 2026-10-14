import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { wildcardFile } from "./wildcard-schema";

export const extractionRun = pgTable("extraction_run", {
  id: uuid("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => wildcardFile.id, { onDelete: "cascade" }),
  method: text("method").notNull(), sealedConfig: text("sealed_config").notNull(), sealedResult: text("sealed_result"),
  resultDigest: text("result_digest"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("extraction_run_file_idx").on(t.userId, t.fileId, t.createdAt)]);

// Only dispatch metadata can cross the trusted web-side queue context. Never put document text here.
export const extractionJob = pgTable("extraction_job", {
  id: uuid("id").primaryKey().references(() => extractionRun.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(), status: text("status").notNull().default("queued"),
  claimId: uuid("claim_id").unique(), grantHash: text("grant_hash").unique(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }), errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("extraction_job_queue_idx").on(t.status, t.createdAt)]);

export const extractionReference = pgTable("extraction_reference", {
  id: uuid("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => wildcardFile.id, { onDelete: "cascade" }),
  sealedLabels: text("sealed_labels").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("extraction_reference_file_idx").on(t.userId, t.fileId, t.createdAt)]);
