import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { shredUserKeys, unsealField, userKeysFor, type UserKeys } from "@/lib/crypto/user-keys";
import { asUser } from "@/lib/db/rls";
import { chat, chatMessage, user } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createTestDb, createTestUser } from "@/test/db";
import {
  appendMessages,
  ChatSequenceError,
  createChat,
  deleteChat,
  getChat,
  listChats,
  loadMessages,
  MAX_MESSAGE_CHARS,
  MAX_TITLE_LENGTH,
  setChatTitle,
} from "./chats";

const kek = randomBytes(32);
const now = new Date("2026-09-29T12:00:00Z");
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
let db: Db;
let alice: string;
let bob: string;
let aliceKeys: UserKeys;
let bobKeys: UserKeys;

beforeAll(async () => {
  db = await createTestDb();
  alice = await createTestUser(db, "chat_alice");
  bob = await createTestUser(db, "chat_bob");
  aliceKeys = await userKeysFor(db, kek, alice, now);
  bobKeys = await userKeysFor(db, kek, bob, now);
});

const text = (seq: number, role: "user" | "assistant" | "tool_result" = "user", content = `message ${seq}`) => ({ seq, role, content });

describe("chats", () => {
  it("creates chats, lists them by latest activity and seals their titles", async () => {
    const first = await createChat(db, alice, now);
    const second = await createChat(db, alice, later(1));
    expect((await listChats(db, aliceKeys, alice)).slice(0, 2).map((c) => c.id)).toEqual([second, first]);

    expect(await setChatTitle(db, aliceKeys, alice, first, "  Recent   cholesterol\nresults  ")).toBe(true);
    await appendMessages(db, aliceKeys, alice, first, [text(0)], later(2));
    const [top] = await listChats(db, aliceKeys, alice);
    expect(top).toMatchObject({ id: first, title: "Recent cholesterol results" });

    const [row] = await db.select().from(chat).where(eq(chat.id, first));
    expect(row.sealedTitle).not.toContain("cholesterol");
  });

  it("caps titles and clears them when blank", async () => {
    const id = await createChat(db, alice, now);
    await setChatTitle(db, aliceKeys, alice, id, "x".repeat(500));
    expect((await getChat(db, aliceKeys, alice, id))?.title).toHaveLength(MAX_TITLE_LENGTH);
    await setChatTitle(db, aliceKeys, alice, id, "   ");
    expect((await getChat(db, aliceKeys, alice, id))?.title).toBeNull();
  });

  it("stores messages sealed and returns them in order", async () => {
    const id = await createChat(db, alice, now);
    const stored = await appendMessages(
      db,
      aliceKeys,
      alice,
      id,
      [text(0), { seq: 1, role: "assistant", content: '{"text":"Your LDL was 96"}', model: "qwen", usage: { input: 900, output: 40 } }],
      now,
    );
    expect(stored).toBe(2);
    const messages = await loadMessages(db, aliceKeys, alice, id);
    expect(messages.map((m) => [m.seq, m.role, m.content])).toEqual([
      [0, "user", "message 0"],
      [1, "assistant", '{"text":"Your LDL was 96"}'],
    ]);
    expect(messages[1]).toMatchObject({ model: "qwen", usage: { input: 900, output: 40 } });

    const rows = await db.select().from(chatMessage).where(eq(chatMessage.chatId, id));
    for (const row of rows) expect(row.sealedContent).not.toContain("message");
  });

  it("skips messages it already has, so a retried append doesn't duplicate", async () => {
    const id = await createChat(db, alice, now);
    await appendMessages(db, aliceKeys, alice, id, [text(0), text(1, "assistant")], now);
    expect(await appendMessages(db, aliceKeys, alice, id, [text(0), text(1, "assistant")], now)).toBe(0);
    expect(await appendMessages(db, aliceKeys, alice, id, [text(1, "assistant"), text(2)], now)).toBe(1);
    expect((await loadMessages(db, aliceKeys, alice, id)).map((m) => m.seq)).toEqual([0, 1, 2]);
  });

  it("refuses gaps, out-of-order numbers and oversized messages", async () => {
    const id = await createChat(db, alice, now);
    await expect(appendMessages(db, aliceKeys, alice, id, [text(1)], now)).rejects.toBeInstanceOf(ChatSequenceError);
    await expect(appendMessages(db, aliceKeys, alice, id, [text(0), text(2)], now)).rejects.toBeInstanceOf(ChatSequenceError);
    await expect(appendMessages(db, aliceKeys, alice, id, [text(0, "user", "x".repeat(MAX_MESSAGE_CHARS + 1))], now)).rejects.toThrow(RangeError);
    expect(await loadMessages(db, aliceKeys, alice, id)).toEqual([]);
  });

  it("keeps each person's chats to themselves", async () => {
    const id = await createChat(db, alice, now);
    await appendMessages(db, aliceKeys, alice, id, [text(0)], now);
    expect(await getChat(db, bobKeys, bob, id)).toBeUndefined();
    expect(await loadMessages(db, bobKeys, bob, id)).toEqual([]);
    expect(await appendMessages(db, bobKeys, bob, id, [text(1)], now)).toBeUndefined();
    expect(await setChatTitle(db, bobKeys, bob, id, "mine now")).toBe(false);
    expect(await deleteChat(db, bob, id)).toBe(false);
    expect((await listChats(db, bobKeys, bob)).map((c) => c.id)).not.toContain(id);
    expect(await loadMessages(db, aliceKeys, alice, id)).toHaveLength(1);
  });

  it("binds sealed content to its row, so it can't be moved to another message", async () => {
    const id = await createChat(db, alice, now);
    await appendMessages(db, aliceKeys, alice, id, [text(0), text(1)], now);
    const [first, second] = await db.select().from(chatMessage).where(eq(chatMessage.chatId, id)).orderBy(chatMessage.seq);
    expect(() => unsealField(aliceKeys, first.sealedContent, { table: "chat_message", field: "content", rowId: second.id })).toThrow();
  });

  it("deletes a chat's messages with it, and everything with the account", async () => {
    const id = await createChat(db, alice, now);
    await appendMessages(db, aliceKeys, alice, id, [text(0)], now);
    expect(await deleteChat(db, alice, id)).toBe(true);
    expect(await db.select().from(chatMessage).where(eq(chatMessage.chatId, id))).toEqual([]);

    const carol = await createTestUser(db, "chat_carol");
    const carolKeys = await userKeysFor(db, kek, carol, now);
    await appendMessages(db, carolKeys, carol, await createChat(db, carol, now), [text(0)], now);
    await db.delete(user).where(eq(user.id, carol));
    expect(await db.select().from(chat).where(eq(chat.userId, carol))).toEqual([]);
    expect(await db.select().from(chatMessage).where(eq(chatMessage.userId, carol))).toEqual([]);
  });

  it("can't be read once the person's keys are shredded", async () => {
    const dave = await createTestUser(db, "chat_dave");
    const daveKeys = await userKeysFor(db, kek, dave, now);
    const id = await createChat(db, dave, now);
    await appendMessages(db, daveKeys, dave, id, [text(0)], now);
    await shredUserKeys(db, dave);
    const fresh = await userKeysFor(db, kek, dave, now);
    await expect(loadMessages(db, fresh, dave, id)).rejects.toThrow();
  });
});

describe("chat row-level security", () => {
  it("shows only the signed-in person's chats and messages, even when a query forgets to filter", async () => {
    const id = await createChat(db, bob, now);
    await appendMessages(db, bobKeys, bob, id, [text(0)], now);
    await db.execute(sql`create role chat_rls_app nologin`);
    await db.execute(sql`grant all on all tables in schema public to chat_rls_app`);
    const seen = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role chat_rls_app`);
      return asUser(tx as unknown as Db, alice, async (u) => ({
        chats: await u.select({ userId: chat.userId }).from(chat),
        messages: await u.select({ userId: chatMessage.userId }).from(chatMessage),
        deleted: await u.delete(chat).where(eq(chat.id, id)).returning({ id: chat.id }),
      }));
    });
    expect(seen.chats.every((c) => c.userId === alice)).toBe(true);
    expect(seen.messages.every((m) => m.userId === alice)).toBe(true);
    expect(seen.deleted).toEqual([]);
    expect(await getChat(db, bobKeys, bob, id)).toBeDefined();
  });
});
