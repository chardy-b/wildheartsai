import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { json, now, time, uuidPk } from "../columns";

// The chat D1 database (binding CHAT_DB), bound only to the chat Worker. Each conversation's
// content (messages, runs, tool calls, events, the agent's transcript) lives in its own
// ChatConversation Durable Object; this database holds only what spans conversations: each
// owner's conversation list, and saved summaries with their evidence. See "Cloudflare topology"
// in docs/superpowers/specs/2026-10-07-web-owned-chat-security-boundary.md.
//
// `owner_id` is whose list a row is in: a person's id, or `demo:<viewer id>` for someone viewing
// the demo (their rows expire, with the conversation's object, a day after the last question).
// `records_user_id` is whose records the conversation's tools read: the person, or the demo
// chart. Neither can reference the main database, so neither is a foreign key. Owner decision
// (2026-11-20): per-person encryption isn't required, so chat content is stored as is.

const timestamps = {
  createdAt: time("created_at").notNull().default(now),
  updatedAt: time("updated_at").notNull().default(now),
};

export const chatConversation = sqliteTable(
  "chat_conversation",
  {
    id: uuidPk(),
    ownerId: text("owner_id").notNull(),
    recordsUserId: text("records_user_id").notNull(),
    title: text("title").notNull().default("New conversation"),
    expiresAt: time("expires_at"),
    ...timestamps,
  },
  (table) => [index("chat_conversation_owner_created_idx").on(table.ownerId, sql`${table.createdAt} desc`, sql`${table.id} desc`), index("chat_conversation_expires_idx").on(table.expiresAt)],
);

// Which conversation (and so which Durable Object) a run is in: the browser's run routes name
// only the run.
export const chatRun = sqliteTable(
  "chat_run",
  {
    id: uuidPk(),
    ownerId: text("owner_id").notNull(),
    conversationId: text("conversation_id").notNull().references(() => chatConversation.id, { onDelete: "cascade" }),
    createdAt: time("created_at").notNull().default(now),
  },
  (table) => [index("chat_run_owner_idx").on(table.ownerId, table.id)],
);

export const userSummary = sqliteTable(
  "user_summary",
  {
    id: uuidPk(),
    ownerId: text("owner_id").notNull(),
    originatingRunId: text("originating_run_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    title: text("title").notNull(),
    content: json<unknown>("content").notNull(),
    deletedAt: time("deleted_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("user_summary_owner_idempotency_idx").on(table.ownerId, table.idempotencyKey),
    index("user_summary_owner_created_idx").on(table.ownerId, sql`${table.createdAt} desc`, sql`${table.id} desc`),
  ],
);

// The evidence row id is the citation handle shown to the agent. The target (a record or note in
// the main database) and the version it was read at are re-checked through the records RPC on
// every use, which is how freshness is decided.
export const summaryEvidence = sqliteTable(
  "summary_evidence",
  {
    id: uuidPk(),
    ownerId: text("owner_id").notNull(),
    summaryId: text("summary_id").notNull().references(() => userSummary.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["record", "note"] }).notNull(),
    targetId: text("target_id").notNull(),
    version: text("version").notNull(),
    position: integer("position").notNull(),
    createdAt: time("created_at").notNull().default(now),
  },
  (table) => [index("summary_evidence_owner_summary_idx").on(table.ownerId, table.summaryId)],
);
