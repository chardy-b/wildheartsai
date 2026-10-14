import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// Names and bytes can both contain health information. File contents live only
// in encrypted R2 objects; separate encrypted metadata allows future tagging.
export const wildcardFile = pgTable("wildcard_file", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  sealedMetadata: text("sealed_metadata").notNull(),
  objectKey: text("object_key").notNull().unique(),
  // A per-owner keyed SHA-256 fingerprint, never a plaintext content hash.
  contentHmac: text("content_hmac"),
  status: text("status", { enum: ["pending", "finalizing", "ready", "deleting"] }).notNull().default("pending"),
  uploadChunkCount: integer("upload_chunk_count"),
  uploadParts: jsonb("upload_parts").$type<Record<string, string>>(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("wildcard_file_user_uploaded_idx").on(table.userId, table.uploadedAt),
  index("wildcard_file_user_content_idx").on(table.userId, table.contentHmac)]);
