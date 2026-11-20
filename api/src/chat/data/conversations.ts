import { and, desc, eq, isNotNull, lt, lte, or } from "drizzle-orm";
import * as chat from "../../db/chat/schema";
import type { ChatBindings } from "../env";
import { chatDb } from "./summaries";

// The chat Worker's conversation lists and run index (CHAT_DB). Every function takes the owner
// and puts it in every query, as `forUser` does in the main database: a person's id, or
// `demo:<viewer id>` for someone viewing the demo.

export type ConversationRow = typeof chat.chatConversation.$inferSelect;

export async function listConversations(env: ChatBindings, ownerId: string, cursor?: string): Promise<{ rows: ConversationRow[]; hasMore: boolean } | null> {
  const db = chatDb(env);
  let before;
  if (cursor !== undefined) {
    const [row] = await db.select().from(chat.chatConversation).where(and(eq(chat.chatConversation.ownerId, ownerId), eq(chat.chatConversation.id, cursor)));
    if (!row) return null;
    before = or(lt(chat.chatConversation.createdAt, row.createdAt), and(eq(chat.chatConversation.createdAt, row.createdAt), lt(chat.chatConversation.id, row.id)));
  }
  const rows = (await db.select().from(chat.chatConversation).where(and(eq(chat.chatConversation.ownerId, ownerId), before)).orderBy(desc(chat.chatConversation.createdAt), desc(chat.chatConversation.id)).limit(33))
    .filter((row) => !row.expiresAt || row.expiresAt > new Date());
  return { rows: rows.slice(0, 32), hasMore: rows.length > 32 };
}

export async function createConversation(env: ChatBindings, row: { id: string; ownerId: string; recordsUserId: string; expiresAt: Date | null }): Promise<ConversationRow> {
  const now = new Date();
  const [created] = await chatDb(env).insert(chat.chatConversation).values({ ...row, createdAt: now, updatedAt: now }).returning();
  return created;
}

export async function ownedConversation(env: ChatBindings, ownerId: string, id: string): Promise<ConversationRow | null> {
  const [row] = await chatDb(env).select().from(chat.chatConversation).where(and(eq(chat.chatConversation.id, id), eq(chat.chatConversation.ownerId, ownerId)));
  return row && (!row.expiresAt || row.expiresAt > new Date()) ? row : null;
}

export async function deleteConversation(env: ChatBindings, ownerId: string, id: string): Promise<void> {
  await chatDb(env).delete(chat.chatConversation).where(and(eq(chat.chatConversation.id, id), eq(chat.chatConversation.ownerId, ownerId)));
}

// A run, once its conversation's object accepted it: indexed for the run routes, and the
// conversation touched (its title from the first question; a demo conversation's day restarted).
export async function recordRun(env: ChatBindings, ownerId: string, conversation: ConversationRow, runId: string, question: string, expiresAt: Date | null): Promise<void> {
  const db = chatDb(env);
  await db.batch([
    db.insert(chat.chatRun).values({ id: runId, ownerId, conversationId: conversation.id }),
    db.update(chat.chatConversation).set({ updatedAt: new Date(), ...(expiresAt ? { expiresAt } : {}), ...(conversation.title === "New conversation" ? { title: question.slice(0, 80) } : {}) })
      .where(and(eq(chat.chatConversation.id, conversation.id), eq(chat.chatConversation.ownerId, ownerId))),
  ]);
}

export async function ownedRun(env: ChatBindings, ownerId: string, runId: string) {
  const [row] = await chatDb(env).select().from(chat.chatRun).where(and(eq(chat.chatRun.id, runId), eq(chat.chatRun.ownerId, ownerId)));
  return row ?? null;
}

// For the hourly sweep: demo conversations past their day (any owner; ids only).
export async function expiredConversations(env: ChatBindings): Promise<string[]> {
  return (await chatDb(env).select({ id: chat.chatConversation.id }).from(chat.chatConversation).where(and(isNotNull(chat.chatConversation.expiresAt), lte(chat.chatConversation.expiresAt, new Date()))).limit(500)).map((r) => r.id);
}

export async function forgetExpiredConversation(env: ChatBindings, id: string): Promise<void> {
  await chatDb(env).delete(chat.chatConversation).where(and(eq(chat.chatConversation.id, id), isNotNull(chat.chatConversation.expiresAt), lte(chat.chatConversation.expiresAt, new Date())));
}
