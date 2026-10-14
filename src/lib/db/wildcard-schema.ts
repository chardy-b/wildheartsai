import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// Names and bytes can both contain health information. File contents live only
// in encrypted R2 objects; separate encrypted metadata allows future tagging.
export const wildcardFile = pgTable("wildcard_file", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  sealedMetadata: text("sealed_metadata").notNull(),
  // Verified SHA-256, HMAC-keyed per account; never store the raw digest.
  contentFingerprint: text("content_fingerprint"),
  objectKey: text("object_key").notNull().unique(),
  status: text("status", { enum: ["pending", "finalizing", "ready", "deleting"] }).notNull().default("pending"),
  uploadChunkCount: integer("upload_chunk_count"),
  uploadParts: jsonb("upload_parts").$type<Record<string, string>>(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("wildcard_file_user_uploaded_idx").on(table.userId, table.uploadedAt),
  index("wildcard_file_user_fingerprint_idx").on(table.userId, table.contentFingerprint),
  index("wildcard_file_user_size_idx").on(table.userId, table.sizeBytes)]);
