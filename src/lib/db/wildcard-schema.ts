import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// Names and bytes can both contain health information. File contents live only
// in encrypted R2 objects; separate encrypted metadata allows future tagging.
export const wildcardFile = pgTable("wildcard_file", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  sealedMetadata: text("sealed_metadata").notNull(),
  objectKey: text("object_key").notNull().unique(),
  status: text("status", { enum: ["pending", "ready", "deleting"] }).notNull().default("pending"),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("wildcard_file_user_uploaded_idx").on(table.userId, table.uploadedAt)]);
