import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// What happened to a person's records and connections, and when: connecting, syncing,
// disconnecting, deleting and exporting. Never health data, organization names, tokens or
// patient identifiers: only ids, counts and statuses (see src/lib/audit.ts).
// No foreign keys, so the trail outlives the source (and account) it describes.
export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    sourceId: uuid("source_id"),
    action: text("action", { enum: ["connect", "reconnect", "disconnect", "delete_source", "sync", "export"] }).notNull(),
    detail: jsonb("detail").$type<Record<string, string | number | boolean>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_event_user_idx").on(table.userId, table.createdAt.desc())],
);
