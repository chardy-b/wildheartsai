import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { sealField, unsealField, type UserKeys } from "@/lib/crypto/user-keys";
import { chat, chatMessage, type ChatUsage } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

// Chats about a person's records (docs/superpowers/specs/2026-09-29-records-chat-design.md §3).
// Callers run these inside asUser(db, userId, …); every query also filters on userId.

export const MAX_TITLE_LENGTH = 120;
// About 200 KB of text: far above any answer or capped tool result, low enough to refuse junk.
export const MAX_MESSAGE_CHARS = 200_000;

export type ChatRole = (typeof chatMessage.$inferInsert)["role"];

export type ChatSummary = { id: string; title: string | null; createdAt: Date; updatedAt: Date };

export type StoredChatMessage = {
  id: string;
  seq: number;
  role: ChatRole;
  content: string;
  model: string | null;
  usage: ChatUsage | null;
  createdAt: Date;
};

export type NewChatMessage = { seq: number; role: ChatRole; content: string; model?: string; usage?: ChatUsage };

// An append that would leave a gap in the numbering, or isn't numbered in order.
export class ChatSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatSequenceError";
  }
}

const titleField = (chatId: string) => ({ table: "chat", field: "title", rowId: chatId });
const contentField = (messageId: string) => ({ table: "chat_message", field: "content", rowId: messageId });

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

function summaryOf(keys: UserKeys, row: typeof chat.$inferSelect): ChatSummary {
  return {
    id: row.id,
    title: row.sealedTitle === null ? null : unsealField(keys, row.sealedTitle, titleField(row.id)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createChat(db: Db, userId: string, now: Date): Promise<string> {
  const [row] = await db.insert(chat).values({ userId, createdAt: now, updatedAt: now }).returning({ id: chat.id });
  return row.id;
}

// Newest activity first.
export async function listChats(db: Db, keys: UserKeys, userId: string): Promise<ChatSummary[]> {
  const rows = await db.select().from(chat).where(eq(chat.userId, userId)).orderBy(desc(chat.updatedAt), desc(chat.id));
  return rows.map((row) => summaryOf(keys, row));
}

// The chat if it's this person's, else undefined.
export async function getChat(db: Db, keys: UserKeys, userId: string, chatId: string): Promise<ChatSummary | undefined> {
  const [row] = await db.select().from(chat).where(and(eq(chat.id, chatId), eq(chat.userId, userId))).limit(1);
  return row && summaryOf(keys, row);
}

// Renaming doesn't move the chat in the list: only new messages do.
export async function setChatTitle(db: Db, keys: UserKeys, userId: string, chatId: string, title: string): Promise<boolean> {
  const cleaned = cleanTitle(title);
  const sealedTitle = cleaned ? sealField(keys, cleaned, titleField(chatId)) : null;
  const rows = await db
    .update(chat)
    .set({ sealedTitle })
    .where(and(eq(chat.id, chatId), eq(chat.userId, userId)))
    .returning({ id: chat.id });
  return rows.length > 0;
}

// Deletes the chat and its messages.
export async function deleteChat(db: Db, userId: string, chatId: string): Promise<boolean> {
  const rows = await db.delete(chat).where(and(eq(chat.id, chatId), eq(chat.userId, userId))).returning({ id: chat.id });
  return rows.length > 0;
}

export async function loadMessages(db: Db, keys: UserKeys, userId: string, chatId: string): Promise<StoredChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessage)
    .where(and(eq(chatMessage.chatId, chatId), eq(chatMessage.userId, userId)))
    .orderBy(asc(chatMessage.seq));
  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    role: row.role,
    content: unsealField(keys, row.sealedContent, contentField(row.id)),
    model: row.model,
    usage: row.usage,
    createdAt: row.createdAt,
  }));
}

// Appends messages numbered from the chat's current count. Messages already stored under the
// same numbers are skipped, so a retried append is harmless; a gap is refused. Returns how many
// were stored, or undefined if the chat isn't this person's. Call inside a transaction (asUser):
// the chat row is locked so two appends can't interleave.
export async function appendMessages(
  db: Db,
  keys: UserKeys,
  userId: string,
  chatId: string,
  messages: NewChatMessage[],
  now: Date,
): Promise<number | undefined> {
  const [owned] = await db
    .select({ id: chat.id })
    .from(chat)
    .where(and(eq(chat.id, chatId), eq(chat.userId, userId)))
    .for("update");
  if (!owned) return undefined;
  if (messages.length === 0) return 0;

  messages.forEach((message, i) => {
    if (!Number.isInteger(message.seq) || message.seq !== messages[0].seq + i) throw new ChatSequenceError("Messages must be numbered consecutively");
    if (message.content.length > MAX_MESSAGE_CHARS) throw new RangeError(`Message ${message.seq} is too long`);
  });
  const [{ stored }] = await db.select({ stored: count() }).from(chatMessage).where(eq(chatMessage.chatId, chatId));
  if (messages[0].seq < 0 || messages[0].seq > stored) {
    throw new ChatSequenceError(`Expected the next message to be number ${stored}, got ${messages[0].seq}`);
  }

  const fresh = messages.filter((message) => message.seq >= stored);
  if (fresh.length === 0) return 0;
  await db.insert(chatMessage).values(
    fresh.map((message) => {
      const id = randomUUID();
      return {
        id,
        chatId,
        userId,
        seq: message.seq,
        role: message.role,
        sealedContent: sealField(keys, message.content, contentField(id)),
        model: message.model ?? null,
        usage: message.usage ?? null,
        createdAt: now,
      };
    }),
  );
  await db.update(chat).set({ updatedAt: now }).where(eq(chat.id, chatId));
  return fresh.length;
}
