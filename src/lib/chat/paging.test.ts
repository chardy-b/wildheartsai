import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import type { Db } from "@/lib/db/types";
import { chatConversation, chatMessage, chatRun, fhirResource, healthSource, userSummary } from "@/lib/db/schema";
import { CHAT_BROWSER_PAGE_BYTES, ChatPageCursorError, ChatPageSizeError, createConversation, createRun, createUserMessage, listConversationPage, listMessagePage, listMessages, listRunsForMessages, listSummaryPage, saveSummary } from "./store";
async function fixture() {
  const db = await createTestDb();
  const client = (db as unknown as { $client: PGlite }).$client;
  const provisioning = await readFile("scripts/provision-chat-roles.sql", "utf8");
  await client.exec(provisioning.slice(provisioning.indexOf("BEGIN;")).replace(/PASSWORD :'chat_(data|queue)_password'/g, ""));
  const data = new Proxy(db, { get(target, property) {
    if (property === "transaction") return (work: (tx: Db) => Promise<unknown>) => target.transaction(async raw => { const tx = raw as unknown as Db; await tx.execute(sql.raw("set local role wildhearts_chat_data")); return work(tx); });
    return Reflect.get(target, property);
  } });
  const alice = await createTestUser(db, "paging_alice"); const bob = await createTestUser(db, "paging_bob"); const now = new Date("2026-10-08T00:00:00Z");
  const conversation = await createConversation(data, { userId: alice }, { now }); const foreign = await createConversation(data, { userId: bob }, { now });
  const records = new Map<string, string>();
  for (const userId of [alice, bob]) {
    const [source] = await db.insert(healthSource).values({ userId, vendor: "epic", fhirBaseUrl: `https://${userId}.example/R4`, organizationName: "Synthetic source", status: "disconnected" }).returning();
    const id = randomUUID();
    await db.insert(fhirResource).values({ id, userId, sourceId: source.id, resourceType: "Observation", fhirId: id, category: "lab", contentHmac: id, sealedResource: "synthetic-unused", sealedSummary: "synthetic-unused", normalizerVersion: 2, firstSeenAt: now, lastSeenAt: now });
    records.set(userId, id);
  }
  const scope = { userId: alice, conversationId: conversation.id };
  return { db, data, alice, bob, now, conversation, foreign, scope, records, add: (content: string) => createUserMessage(data, scope, { content, now }) };
}

describe("bounded browser chat history pages", () => {
  it("pages conversations by immutable creation time and UUID ties without leaks or duplicates", async () => {
    const f = await fixture(); const ids = [f.conversation.id];
    for (let i = 0; i < 64; i++) ids.push((await createConversation(f.data, { userId: f.alice }, { now: f.now })).id);
    await f.db.update(chatConversation).set({ createdAt: sql`timestamp with time zone '2026-10-08T00:00:00.123456Z'` }).where(eq(chatConversation.userId, f.alice));
    const expected = ids.sort().reverse(); const first = await listConversationPage(f.data, { userId: f.alice });
    expect(first.conversations.map(row => row.id)).toEqual(expected.slice(0, 32)); expect(first).toMatchObject({ hasMore: true, nextCursor: expected[31] });
    await f.db.update(chatConversation).set({ updatedAt: new Date("2027-01-01") }).where(eq(chatConversation.id, expected[64]));
    const second = await listConversationPage(f.data, { userId: f.alice }, { cursor: first.nextCursor! }); const third = await listConversationPage(f.data, { userId: f.alice }, { cursor: second.nextCursor! });
    expect([...first.conversations, ...second.conversations, ...third.conversations].map(row => row.id)).toEqual(expected); expect(third).toMatchObject({ hasMore: false, nextCursor: null });
    await expect(listConversationPage(f.data, { userId: f.alice }, { cursor: f.foreign.id })).rejects.toBeInstanceOf(ChatPageCursorError);
    await expect(listConversationPage(f.data, { userId: f.alice }, { cursor: "invalid" })).rejects.toBeInstanceOf(ChatPageCursorError);
    await expect(listConversationPage(f.data, { userId: f.alice }, { limit: 65 })).rejects.toBeInstanceOf(ChatPageCursorError);
  });
  it("returns ascending recent suffixes with stable before cursors and no gaps", async () => {
    const f = await fixture(); for (let i = 1; i <= 45; i++) await f.add(`Synthetic turn ${i}`);
    const first = await listMessagePage(f.data, f.scope); const second = await listMessagePage(f.data, f.scope, { before: first.nextBefore! }); const third = await listMessagePage(f.data, f.scope, { before: second.nextBefore! });
    expect(first.messages.map(row => row.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => i + 26)); expect(second.messages.map(row => row.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6)); expect(third.messages.map(row => row.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(first).toMatchObject({ hasMore: true, nextBefore: 26 }); expect(second).toMatchObject({ hasMore: true, nextBefore: 6 }); expect(third).toMatchObject({ hasMore: false, nextBefore: null });
    expect((await listMessagePage(f.data, f.scope, { before: 1 })).messages).toEqual([]);
    for (const before of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) await expect(listMessagePage(f.data, f.scope, { before })).rejects.toBeInstanceOf(ChatPageCursorError);
    await expect(listMessagePage(f.data, { userId: f.bob, conversationId: f.conversation.id })).rejects.toThrow();
  });
  it("counts serialized UTF-8 bytes without clipping valid Unicode or escaped control text", async () => {
    const f = await fixture(); const wide = String.fromCharCode(0x6f22).repeat(12_000); const control = String.fromCharCode(0).repeat(12_000); const input = [wide, control, wide, control, wide];
    for (const content of input) await f.add(content);
    const seen = new Map<number, string>(); let before: number | undefined;
    do {
      const page = await listMessagePage(f.data, f.scope, { before }); expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(CHAT_BROWSER_PAGE_BYTES); expect(page.messages.every(row => !row.truncated)).toBe(true);
      for (const row of page.messages) { expect(seen.has(row.sequence)).toBe(false); seen.set(row.sequence, row.content); }
      before = page.nextBefore ?? undefined;
    } while (before !== undefined);
    expect([...seen.entries()].sort(([a], [b]) => a - b).map(([, text]) => text)).toEqual(input);
  });
  it("clips oversized legacy display text with a visible flag, preserving Unicode and cursor progress", async () => {
    const f = await fixture(); const emoji = String.fromCodePoint(0x1f600); const original = emoji.repeat(50_000); await f.add("Synthetic earlier row"); await f.add(original);
    const first = await listMessagePage(f.data, f.scope); expect(first.messages).toHaveLength(1); expect(first.messages[0].truncated).toBe(true); expect(first.messages[0].content.endsWith(emoji)).toBe(true); expect(Buffer.byteLength(JSON.stringify(first.messages))).toBeLessThanOrEqual(CHAT_BROWSER_PAGE_BYTES); expect(first).toMatchObject({ hasMore: true, nextBefore: 2 });
    expect((await listMessagePage(f.data, f.scope, { before: first.nextBefore! })).messages).toMatchObject([{ sequence: 1, content: "Synthetic earlier row", truncated: false }]); expect((await listMessages(f.data, f.scope))[1].content).toBe(original);
  });
  it("does not decrypt rows outside the bounded candidate query", async () => {
    const f = await fixture(); const older = await f.add("Synthetic older row"); for (let i = 0; i < 20; i++) await f.add("Synthetic current page");
    await f.db.update(chatMessage).set({ sealedContent: "malformed-legacy-ciphertext" }).where(eq(chatMessage.id, older.id)); const page = await listMessagePage(f.data, f.scope); expect(page.messages).toHaveLength(20); expect(page).toMatchObject({ hasMore: true, nextBefore: 2 });
  });
  it("reserves array overhead at the exact legacy message byte boundary", async () => {
    const f = await fixture();
    const sample = await f.add("x");
    const overhead = Buffer.byteLength(JSON.stringify({ ...sample, truncated: false })) - 1;
    for (const size of [CHAT_BROWSER_PAGE_BYTES - 1, CHAT_BROWSER_PAGE_BYTES]) {
      const conversation = await createConversation(f.data, { userId: f.alice }, { now: f.now });
      const scope = { userId: f.alice, conversationId: conversation.id };
      await createUserMessage(f.data, scope, { content: "x".repeat(size - overhead), now: f.now });
      const page = await listMessagePage(f.data, scope);
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0].truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(CHAT_BROWSER_PAGE_BYTES);
      expect(page.hasMore).toBe(false);
    }
  });
  it("returns only bounded page-related runs and the latest active run when explicitly requested", async () => {
    const f = await fixture(); const old = await f.add("Synthetic old parent"); const recent = await f.add("Synthetic active parent"); let latestOld = "";
    for (let i = 0; i < 5; i++) { const run = await createRun(f.data, f.scope, { parentMessageId: old.id, idempotencyKey: randomUUID(), now: new Date(f.now.getTime() + i) }); latestOld = run.id; await f.db.update(chatRun).set({ status: "completed" }).where(eq(chatRun.id, run.id)); }
    const active = await createRun(f.data, f.scope, { parentMessageId: recent.id, idempotencyKey: randomUUID(), now: new Date(f.now.getTime() + 6) });
    expect((await listRunsForMessages(f.data, f.scope, [old.id])).map(run => run.id)).toEqual([latestOld]); expect((await listRunsForMessages(f.data, f.scope, [old.id], { includeActive: true })).map(run => run.id)).toEqual([latestOld, active.id]);
    const foreignMessage = await createUserMessage(f.data, { userId: f.bob, conversationId: f.foreign.id }, { content: "Synthetic foreign message" }); await createRun(f.data, { userId: f.bob, conversationId: f.foreign.id }, { parentMessageId: foreignMessage.id, idempotencyKey: randomUUID() }); expect(await listRunsForMessages(f.data, f.scope, [foreignMessage.id])).toEqual([]);
    await expect(listRunsForMessages(f.data, f.scope, Array.from({ length: 21 }, () => old.id))).rejects.toBeInstanceOf(ChatPageCursorError);
  });
  it("pages summaries under the byte cap with stable cursors across freshness and soft deletion", async () => {
    const f = await fixture(); const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await saveSummary(f.data, { userId: f.alice }, { idempotencyKey: randomUUID(), title: "Synthetic summary", text: String.fromCharCode(0x6f22).repeat(12_000), coverageState: "partial", evidence: [{ kind: "record", targetId: f.records.get(f.alice)! }], now: f.now })).id);
    const foreign = await saveSummary(f.data, { userId: f.bob }, { idempotencyKey: randomUUID(), title: "Foreign synthetic", text: "Foreign synthetic content", coverageState: "unknown", evidence: [{ kind: "record", targetId: f.records.get(f.bob)! }], now: f.now }); await f.db.update(userSummary).set({ createdAt: sql`timestamp with time zone '2026-10-08T00:00:00.123456Z'` }).where(eq(userSummary.userId, f.alice)); const expected = ids.sort().reverse(); const seen: string[] = [];
    const first = await listSummaryPage(f.data, { userId: f.alice }); seen.push(...first.summaries.map(row => row.id)); expect(first.summaries).toHaveLength(2); expect(first.nextCursor).toBe(expected[1]);
    await f.db.update(userSummary).set({ deletedAt: new Date(), freshness: "stale", updatedAt: new Date("2027-01-01") }).where(eq(userSummary.id, first.nextCursor!)); let cursor = first.nextCursor;
    while (cursor) { const page = await listSummaryPage(f.data, { userId: f.alice }, { cursor }); expect(Buffer.byteLength(JSON.stringify(page.summaries))).toBeLessThanOrEqual(CHAT_BROWSER_PAGE_BYTES); seen.push(...page.summaries.map(row => row.id)); cursor = page.nextCursor; }
    expect(seen).toEqual(expected); expect(new Set(seen).size).toBe(5); await expect(listSummaryPage(f.data, { userId: f.alice }, { cursor: foreign.id })).rejects.toBeInstanceOf(ChatPageCursorError);
    await saveSummary(f.data, { userId: f.alice }, { idempotencyKey: randomUUID(), title: "Oversized legacy", text: String.fromCharCode(0).repeat(20_000), coverageState: "unknown", evidence: [{ kind: "record", targetId: f.records.get(f.alice)! }], now: new Date(f.now.getTime() + 1_000) }); await expect(listSummaryPage(f.data, { userId: f.alice })).rejects.toBeInstanceOf(ChatPageSizeError);
  });
});
