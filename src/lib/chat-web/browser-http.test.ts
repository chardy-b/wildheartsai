import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { session, chatRun, chatMessage } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createConversation, createUserMessage, submitQuestionAndRun } from "@/lib/chat/store";

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), getSession: vi.fn() }));
vi.mock("./runtime", () => ({ webChatRuntime: mocks.runtime, ChatUnavailableError: class extends Error {} }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/env", () => ({ appUrl: () => "https://wildhearts.example" }));
import { browserRequest } from "./browser-http";

async function fixture() {
  const db = await createTestDb();
  const client = (db as unknown as { $client: PGlite }).$client;
  const provisioning = await readFile("scripts/provision-chat-roles.sql", "utf8");
  await client.exec(provisioning.slice(provisioning.indexOf("BEGIN;")).replace(/PASSWORD :'chat_(data|queue)_password'/g, ""));
  const dataDb = new Proxy(db, { get(target, property) {
    if (property === "transaction") return (work: (tx: Db) => Promise<unknown>) => target.transaction(async raw => {
      const tx = raw as unknown as Db;
      await tx.execute(sql.raw("set local role wildhearts_chat_data"));
      return work(tx);
    });
    return Reflect.get(target, property);
  } });
  const alice = await createTestUser(db, "browser_alice");
  const bob = await createTestUser(db, "browser_bob");
  const now = new Date();
  for (const userId of [alice, bob]) await db.insert(session).values({ id: `session-${userId}`, userId, token: `synthetic-${userId}`, expiresAt: new Date(now.getTime() + 3600_000), createdAt: now, updatedAt: now });
  const identity = { user: { id: alice, emailVerified: true }, session: { id: `session-${alice}` } };
  mocks.getSession.mockResolvedValue(identity);
  mocks.runtime.mockResolvedValue({ dataDb, authority: { reap: async () => 0 } });
  const aliceConversation = await createConversation(dataDb, { userId: alice });
  const bobConversation = await createConversation(dataDb, { userId: bob });
  const call = (method: string, path: string[], value?: unknown, idempotencyKey = randomUUID(), search = "") => browserRequest(new Request(`https://wildhearts.example/api/chat/v1/${path.join("/")}${search}`, {
    method, headers: { origin: "https://wildhearts.example", "content-type": "application/json", "idempotency-key": idempotencyKey },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }), path);
  return { db, dataDb, alice, bob, aliceConversation, bobConversation, call, identity };
}
beforeEach(() => vi.clearAllMocks());

describe("same-origin browser chat against the restricted data role", () => {
  it("persists one turn across duplicate submissions and binds work to the authenticated session", async () => {
    const f = await fixture(); const key = randomUUID(); const path = ["conversations", f.aliceConversation.id, "runs"];
    const first = await f.call("POST", path, { message: "Synthetic question" }, key);
    expect(first.status).toBe(202);
    const reply = await first.json();
    const duplicate = await f.call("POST", path, { message: "Synthetic question" }, key);
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ runId: reply.runId, created: false });
    const runs = await f.db.select().from(chatRun);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ userId: f.alice, initiatingSessionId: f.identity.session.id, status: "queued" });
    expect(JSON.stringify(await f.db.select().from(chatMessage))).not.toContain("Synthetic question");
    const history = await f.call("GET", ["conversations", f.aliceConversation.id]);
    expect(history.status).toBe(200);
    expect((await history.json()).messages).toMatchObject([{ content: "Synthetic question" }]);
  });

  it("hides another person's conversation/run and rejects model or caller identity fields", async () => {
    const f = await fixture();
    const submitted = await submitQuestionAndRun(f.dataDb, { userId: f.bob, conversationId: f.bobConversation.id }, { message: "Bob synthetic question", idempotencyKey: randomUUID(), initiatingSessionId: `session-${f.bob}` });
    for (const [method, path] of [["GET", ["conversations", f.bobConversation.id]], ["DELETE", ["conversations", f.bobConversation.id]], ["GET", ["runs", submitted.run.id, "events"]], ["DELETE", ["runs", submitted.run.id]]] as const) {
      expect((await f.call(method, [...path])).status).toBe(404);
    }
    expect((await f.call("POST", ["conversations", f.aliceConversation.id, "runs"], { message: "Synthetic", userId: f.bob })).status).toBe(400);
    const listed = await f.call("GET", ["conversations"]);
    expect((await listed.json()).conversations.map((row: { id: string }) => row.id)).toEqual([f.aliceConversation.id]);
    expect(await f.db.select().from(chatRun)).toHaveLength(1);
  });

  it("rejects a stale auth cache after logout or session expiration", async () => {
    const f = await fixture();
    await f.db.delete(session).where(eq(session.id, f.identity.session.id));
    expect((await f.call("GET", ["conversations", f.aliceConversation.id])).status).toBe(401);
    expect((await f.call("POST", ["conversations", f.aliceConversation.id, "runs"], { message: "Synthetic" })).status).toBe(401);
    expect(await f.db.select().from(chatRun)).toEqual([]);
  });

  it("pages large Unicode history without exceeding response limits or exposing foreign cursors", async () => {
    const f = await fixture();
    const owned = { userId: f.alice, conversationId: f.aliceConversation.id };
    for (let n = 0; n < 7; n++) await createUserMessage(f.dataDb, owned, { content: "語".repeat(12_000) });
    const recent = await f.call("GET", ["conversations", f.aliceConversation.id]);
    expect(recent.status).toBe(200);
    const page = await recent.json();
    expect(page.hasMore).toBe(true);
    expect(page.messages.length).toBeLessThan(7);
    expect(page.messages.every((message: { truncated: boolean }) => !message.truncated)).toBe(true);
    const previous = await f.call("GET", ["conversations", f.aliceConversation.id], undefined, randomUUID(), `?before=${page.nextBefore}`);
    expect(previous.status).toBe(200);
    const older = await previous.json();
    expect(older.messages.at(-1).sequence).toBeLessThan(page.messages[0].sequence);
    expect((await f.call("GET", ["conversations"], undefined, randomUUID(), `?before=${f.bobConversation.id}`)).status).toBe(400);
    expect((await f.call("GET", ["conversations", f.aliceConversation.id], undefined, randomUUID(), "?before=not-a-sequence")).status).toBe(400);
  });
});
