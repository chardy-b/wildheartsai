import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { bool, json, now, time, uuidPk } from "../columns";
import { user } from "./auth";

// Names and bytes can both contain health information. File contents live only in encrypted
// R2 objects; separate encrypted metadata allows future tagging.
export const wildcardFile = sqliteTable(
  "wildcard_file",
  {
    id: uuidPk(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    sealedMetadata: text("sealed_metadata").notNull(),
    // Verified SHA-256, HMAC-keyed per account; never store the raw digest.
    contentFingerprint: text("content_fingerprint"),
    objectKey: text("object_key").notNull().unique(),
    status: text("status", { enum: ["pending", "finalizing", "ready", "deleting"] }).notNull().default("pending"),
    uploadChunkCount: integer("upload_chunk_count"),
    uploadParts: json<Record<string, string>>("upload_parts"),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedAt: time("uploaded_at").notNull().default(now),
  },
  (table) => [
    index("wildcard_file_user_uploaded_idx").on(table.userId, table.uploadedAt),
    index("wildcard_file_user_fingerprint_idx").on(table.userId, table.contentFingerprint),
    index("wildcard_file_user_size_idx").on(table.userId, table.sizeBytes),
  ],
);

export const extractionRun = sqliteTable(
  "extraction_run",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull().references(() => wildcardFile.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    sealedConfig: text("sealed_config").notNull(),
    sealedResult: text("sealed_result"),
    resultDigest: text("result_digest"),
    createdAt: time("created_at").notNull().default(now),
  },
  (t) => [index("extraction_run_file_idx").on(t.userId, t.fileId, t.createdAt)],
);

// Only dispatch metadata can cross the trusted queue context. Never put document text here.
export const extractionJob = sqliteTable(
  "extraction_job",
  {
    id: text("id").primaryKey().references(() => extractionRun.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    status: text("status").notNull().default("queued"),
    durable: bool("durable").notNull().default(false),
    claimId: text("claim_id").unique(),
    grantHash: text("grant_hash").unique(),
    deadlineAt: time("deadline_at"),
    errorCode: text("error_code"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: time("next_attempt_at").notNull().default(now),
    createdAt: time("created_at").notNull().default(now),
  },
  (t) => [index("extraction_job_queue_idx").on(t.status, t.createdAt)],
);

export const extractionReference = sqliteTable(
  "extraction_reference",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull().references(() => wildcardFile.id, { onDelete: "cascade" }),
    sealedLabels: text("sealed_labels").notNull(),
    createdAt: time("created_at").notNull().default(now),
  },
  (t) => [index("extraction_reference_file_idx").on(t.userId, t.fileId, t.createdAt)],
);
