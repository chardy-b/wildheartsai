import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// Chats about a person's records. Design: docs/superpowers/specs/2026-09-29-records-chat-design.md
// Titles and message content come from the person or the model and quote their records, so both
// are sealed with the owner's data key (src/lib/crypto/user-keys.ts), bound to table, column,
// user and row. Plaintext columns are ordering and bookkeeping only.

export type ChatUsage = { input: number; output: number };

export const chat = pgTable(
  "chat",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Set after the first answer; null until then.
    sealedTitle: text("sealed_title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // The last message's time, for ordering the chat list.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("chat_user_idx").on(table.userId, table.updatedAt.desc())],
);

// One message in a chat, numbered from 0. The agent sends each message's number, so a retried
// append can't store a message twice.
export const chatMessage = pgTable(
  "chat_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant", "tool_result"] }).notNull(),
    // The agent's message as JSON: text, tool calls or a tool's result.
    sealedContent: text("sealed_content").notNull(),
    // Which model answered (assistant messages only).
    model: text("model"),
    // Token counts only.
    usage: jsonb("usage").$type<ChatUsage>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("chat_message_seq_idx").on(table.chatId, table.seq)],
);
