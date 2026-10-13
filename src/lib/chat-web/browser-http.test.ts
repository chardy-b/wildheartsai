import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { session, chatRun, chatMessage } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createConversation, createUserMessage, submitQuestionAndRun, claimRun, appendWorkerEvent, finalizeWorkerEvent } from "@/lib/chat/store";

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
  const authority = {
    reap: vi.fn(async () => 0),
    modelWarmupStatus: vi.fn(async (): Promise<{ status: "idle" | "queued" | "running" | "ready" | "failed"; retryAt: string | null; readyUntil: string | null }> => ({ status: "idle", retryAt: null, readyUntil: null })),
    requestModelWarmup: vi.fn(async () => "queued"),
  };
  mocks.runtime.mockResolvedValue({ dataDb, authority });
  const aliceConversation = await createConversation(dataDb, { userId: alice });
  const bobConversation = await createConversation(dataDb, { userId: bob });
  const call = (method: string, path: string[], value?: unknown, idempotencyKey = randomUUID(), search = "") => browserRequest(new Request(`https://wildhearts.example/api/chat/v1/${path.join("/")}${search}`, {
    method, headers: { origin: "https://wildhearts.example", "content-type": "application/json", "idempotency-key": idempotencyKey },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }), path);
  return { db, dataDb, authority, alice, bob, aliceConversation, bobConversation, call, identity };
}
beforeEach(() => vi.clearAllMocks());

describe("same-origin browser chat against the restricted data role", () => {
  it("returns only bounded warm-up state before opening a patient-scoped data transaction", async () => {
    const f = await fixture();
    f.authority.modelWarmupStatus.mockResolvedValue({ status: "ready", retryAt: null, readyUntil: "2026-10-08T20:05:00.000Z" });
    const status = await f.call("GET", ["warmup"]);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: "ready", retryAt: null, readyUntil: "2026-10-08T20:05:00.000Z" });
    const started = await f.call("POST", ["warmup"], {});
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ status: "ready", retryAt: null, readyUntil: "2026-10-08T20:05:00.000Z" });
    expect(f.authority.requestModelWarmup).toHaveBeenCalledTimes(1);
    expect(f.authority.reap).not.toHaveBeenCalled();
    expect((await f.call("POST", ["warmup"], { modelId: "caller-selected" })).status).toBe(400);
  });

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

  it("replays thinking and safe failure details only to the owning browser", async () => {
    const f = await fixture();
    const owned = { userId: f.alice, conversationId: f.aliceConversation.id };
    const submitted = await submitQuestionAndRun(f.dataDb, owned, { message: "Synthetic question", idempotencyKey: randomUUID(), initiatingSessionId: f.identity.session.id });
    const runScope = { ...owned, runId: submitted.run.id };
    const claimed = await claimRun(f.dataDb, runScope, { workerId: "synthetic-worker", leaseMs: 60_000 });
    const scope = { ...runScope, workerId: "synthetic-worker", runAttempt: claimed!.attempt };
    await appendWorkerEvent(f.dataDb, scope, { eventId: randomUUID(), sequence: 1, type: "reasoning.delta", data: { text: "Synthetic thinking" } });
    await finalizeWorkerEvent(f.dataDb, scope, { status: "failed", event: { eventId: randomUUID(), sequence: 2, type: "error", data: { code: "tool_limit_reached", stage: "record_lookup" } } });
    const response = await f.call("GET", ["runs", submitted.run.id, "events"]);
    expect(response.status).toBe(200);
    expect((await response.json()).events).toMatchObject([
      { kind: "reasoning.delta", payload: { text: "Synthetic thinking" } },
      { kind: "run.failed", payload: { status: "failed", code: "tool_limit_reached", stage: "record_lookup" } },
    ]);
    mocks.getSession.mockResolvedValue({ user: { id: f.bob, emailVerified: true }, session: { id: `session-${f.bob}` } });
    expect((await f.call("GET", ["runs", submitted.run.id, "events"])).status).toBe(404);
  });

  it("hides another person's conversation/run and rejects model or caller identity fields", async () => {
    const f = await fixture();
    const submitted = await submitQuestionAndRun(f.dataDb, { userId: f.bob, conversationId: f.bobConversation.id }, { message: "Bob synthetic question", idempotencyKey: randomUUID(), initiatingSessionId: `session-${f.bob}` });
    for (const [method, path] of [["GET", ["conversations", f.bobConversation.id]], ["DELETE", ["conversations", f.bobConversation.id]], ["GET", ["runs", submitted.run.id, "events"]], ["GET", ["runs", submitted.run.id, "research-sources"]], ["DELETE", ["runs", submitted.run.id]]] as const) {
      expect((await f.call(method, [...path])).status).toBe(404);
    }
    expect((await f.call("POST", ["conversations", f.aliceConversation.id, "runs"], { message: "Synthetic", userId: f.bob })).status).toBe(400);
    const listed = await f.call("GET", ["conversations"]);
    expect((await listed.json()).conversations.map((row: { id: string }) => row.id)).toEqual([f.aliceConversation.id]);
    expect(await f.db.select().from(chatRun)).toHaveLength(1);
  });

  it("rejects a stale auth cache after logout or session expiration", async () => {
    const f = await fixture();
    await f.db.update(session).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(session.id, f.identity.session.id));
    expect((await f.call("GET", ["conversations", f.aliceConversation.id])).status).toBe(401);
    await f.db.delete(session).where(eq(session.id, f.identity.session.id));
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

  it("authenticates saved research history and validates numeric pagination cursors", async () => {
    const f = await fixture();
    const submitted = await submitQuestionAndRun(f.dataDb, { userId: f.alice, conversationId: f.aliceConversation.id }, { message: "Synthetic research question", idempotencyKey: randomUUID(), initiatingSessionId: f.identity.session.id });
    const path = ["runs", submitted.run.id, "research-sources"];
    expect((await f.call("GET", path)).status).toBe(200);
    expect(await (await f.call("GET", path, undefined, randomUUID(), "?after=1")).json()).toEqual({ calls: [], hasMore: false, nextAfter: null });
    for (const cursor of ["0", "-1", "01", "1.5", "1e2", "7", "9007199254740992", "not-a-number"]) {
      expect((await f.call("GET", path, undefined, randomUUID(), `?after=${cursor}`)).status).toBe(400);
    }
    await f.db.delete(session).where(eq(session.id, f.identity.session.id));
    expect((await f.call("GET", path)).status).toBe(401);
  });

  it("authenticates FHIR record references and validates pagination", async () => {
    const f = await fixture();
    const submitted = await submitQuestionAndRun(f.dataDb, { userId: f.alice, conversationId: f.aliceConversation.id }, { message: "Synthetic record question", idempotencyKey: randomUUID(), initiatingSessionId: f.identity.session.id });
    const path = ["runs", submitted.run.id, "record-sources"];
    const response = await f.call("GET", path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ sources: [], hasMore: false, nextAfter: null });
    for (const cursor of ["-1", "01", "1.5", "9007199254740992", "601", "not-a-number"]) {
      expect((await f.call("GET", path, undefined, randomUUID(), `?after=${cursor}`)).status).toBe(400);
    }
    mocks.getSession.mockResolvedValue({ user: { id: f.bob, emailVerified: true }, session: { id: `session-${f.bob}` } });
    expect((await f.call("GET", path)).status).toBe(404);
  });
});
