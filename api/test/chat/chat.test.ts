import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_GUEST_COOKIE } from "@/lib/demo/identity";
import { buildDemoScenario } from "@/lib/demo/scenario";
import * as chat from "../../src/db/chat/schema";
import { ensureDemoChart, importEntries, issueGuestViewer } from "../../src/data/demo";
import { forUser } from "../../src/data/scope";
import * as s from "../../src/db/schema";
import { chatDb } from "../../src/chat/data/summaries";
import { LIMITS } from "../../src/limits";
import type { Bindings } from "../../src/env";
import type { ChatBindings, ChatConversation } from "../../src/chat";
import { clearAll, db, origin, recordsKey, signedIn } from "../helpers";

// Chat on Workers: the browser's API, one Durable Object per conversation running Pi durable, the
// records RPC, against a scripted model (test/chat/fake-edge.ts). Fictional records only.
const bindings = env as unknown as Bindings & ChatBindings;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Event = { sequence: number; kind: string; payload: Record<string, unknown> };

function client(cookie: string, workspace = "personal") {
  const send = (path: string, init: RequestInit = {}) =>
    SELF.fetch(`${origin}/api/chat/v1${path}`, { ...init, headers: { cookie, Origin: origin, "x-wildhearts-workspace": workspace, "cf-connecting-ip": "198.51.100.40", ...(init.headers ?? {}) } });
  return {
    send,
    async conversation() {
      const response = await send("/conversations", { method: "POST" });
      expect(response.status, await response.clone().text()).toBe(201);
      return ((await response.json()) as { conversation: { id: string } }).conversation.id;
    },
    ask(conversationId: string, message: string, key = crypto.randomUUID()) {
      return send(`/conversations/${conversationId}/runs`, { method: "POST", body: JSON.stringify({ message }), headers: { "content-type": "application/json", "idempotency-key": key } });
    },
    // Polls a run's events until it ends, as the browser does.
    async finish(runId: string, timeoutMs = 15_000) {
      const events: Event[] = [];
      let after = 0, status = "running";
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await wait(100)) {
        const page = (await (await send(`/runs/${runId}/events?after=${after}`)).json()) as { events: Event[]; status: string; nextSequence: number };
        events.push(...page.events);
        after = page.nextSequence;
        status = page.status;
        if (["completed", "failed", "cancelled", "interrupted"].includes(status)) break;
      }
      return { status, events };
    },
  };
}

// A person with a fictional chart of their own (the demo story, written as theirs).
async function personWithRecords(email: string) {
  const { userId, cookie } = await signedIn(email);
  await importEntries(forUser(db, userId), recordsKey, buildDemoScenario("2026-11-20"), new Date());
  return { userId, cookie, ...client(cookie) };
}

beforeEach(async () => {
  await clearAll();
  await bindings.CHAT_DB.exec("delete from summary_evidence; delete from user_summary; delete from chat_run; delete from chat_conversation;");
});

describe("chat on Workers", () => {
  it("answers through Pi durable: a recorded tool call, events the browser reads, messages, and sources", async () => {
    const a = await personWithRecords("a@example.test");
    const conversationId = await a.conversation();
    const asked = await a.ask(conversationId, "What did my biopsies show?");
    expect(asked.status).toBe(202);
    const { runId } = (await asked.json()) as { runId: string };
    const { status, events } = await a.finish(runId);
    expect(status).toBe("completed");
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("run.started");
    expect(kinds).toContain("tool.started");
    expect(events.find((e) => e.kind === "tool.completed")?.payload).toMatchObject({ tool: "find_records", status: "completed" });
    expect(events.filter((e) => e.kind === "answer.delta").map((e) => e.payload.text).join("")).toContain("I read 1 tool result(s) for you.");
    expect(kinds.slice(-2)).toEqual(["answer.completed", "run.completed"]);

    const page = (await (await a.send(`/conversations/${conversationId}`)).json()) as { messages: { role: string; content: string }[]; runs: { id: string; status: string }[] };
    expect(page.messages.map((m) => [m.role, m.content])).toEqual([["user", "What did my biopsies show?"], ["assistant", "I read 1 tool result(s) for you."]]);
    expect(page.runs).toEqual([expect.objectContaining({ id: runId, status: "completed" })]);
    const sources = (await (await a.send(`/runs/${runId}/record-sources`)).json()) as { sources: { title: string; reference: string }[] };
    expect(sources.sources.length).toBeGreaterThan(0);
    expect(JSON.stringify(sources)).not.toMatch(/sealed|token/i);
    const listed = (await (await a.send("/conversations")).json()) as { conversations: { id: string; title: string }[] };
    expect(listed.conversations).toEqual([expect.objectContaining({ id: conversationId, title: "What did my biopsies show?" })]);
  });

  it("keeps one run at a time, and a repeated post is the same run", async () => {
    const a = await personWithRecords("a@example.test");
    const conversationId = await a.conversation();
    const key = crypto.randomUUID();
    const first = (await (await a.ask(conversationId, "[slow] first", key)).json()) as { runId: string; created: boolean };
    const again = (await (await a.ask(conversationId, "[slow] first", key)).json()) as { runId: string; created: boolean };
    expect([again.runId, again.created]).toEqual([first.runId, false]);
    const busy = await a.ask(conversationId, "another question");
    expect([busy.status, await busy.json()]).toEqual([409, { error: "conversation_busy" }]);
    expect((await a.finish(first.runId)).status).toBe("completed");
  });

  it("keeps people apart: another person's conversation, run and summaries are not found", async () => {
    const a = await personWithRecords("a@example.test");
    const b = client((await signedIn("b@example.test")).cookie);
    const conversationId = await a.conversation();
    const { runId } = (await (await a.ask(conversationId, "[summary] save what you find")).json()) as { runId: string };
    expect((await a.finish(runId)).status).toBe("completed");
    const summaries = (await (await a.send("/summaries")).json()) as { summaries: { id: string; freshness: string }[] };
    expect(summaries.summaries).toEqual([expect.objectContaining({ freshness: "fresh" })]);

    for (const path of [`/conversations/${conversationId}`, `/runs/${runId}/events`, `/runs/${runId}/record-sources`]) expect((await b.send(path)).status).toBe(404);
    expect((await b.send(`/runs/${runId}`, { method: "DELETE" })).status).toBe(404);
    expect((await b.send(`/summaries/${summaries.summaries[0].id}`, { method: "DELETE" })).status).toBe(404);
    expect((await b.ask(conversationId, "hello")).status).toBe(404);
    expect(((await (await b.send("/conversations")).json()) as { conversations: unknown[] }).conversations).toEqual([]);
    expect(((await (await b.send("/summaries")).json()) as { summaries: unknown[] }).summaries).toEqual([]);
  });

  it("stops a run whose session ended, at its next step", async () => {
    const a = await personWithRecords("a@example.test");
    const conversationId = await a.conversation();
    const { runId } = (await (await a.ask(conversationId, "[slowfirst] look things up")).json()) as { runId: string };
    // Sign out while the model is still deciding on its tool call.
    await wait(300);
    await db.delete(s.session).where(eq(s.session.userId, a.userId));
    const events: Event[] = [];
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await wait(200)) {
      const status = await runInDurableObject(bindings.CONVERSATION.get(bindings.CONVERSATION.idFromName(conversationId)), async (instance) => {
        const page = await (instance as unknown as ChatConversation).events(runId, 0);
        events.splice(0, events.length, ...page.events);
        return page.status;
      });
      if (status !== "running") break;
    }
    expect(events.at(-1)).toMatchObject({ kind: "run.failed", payload: { code: "session_ended" } });
    expect(events.find((e) => e.kind === "tool.completed")?.payload).toMatchObject({ status: "failed", code: "session_ended" });
    // Signed out, the browser API answers no one.
    expect((await a.send("/conversations")).status).toBe(401);
  });

  it("resumes a run from its checkpoint after the object is killed, without repeating its tool", async () => {
    const a = await personWithRecords("a@example.test");
    const conversationId = await a.conversation();
    const { runId } = (await (await a.ask(conversationId, "[slow] remember this")).json()) as { runId: string };
    const stub = bindings.CONVERSATION.get(bindings.CONVERSATION.idFromName(conversationId));
    const runEvents = (id: string, after: number) => (stub as unknown as ChatConversation).events(id, after);
    // Wait for the tool to finish, then kill the object during the (slow) answer.
    for (let i = 0; i < 100; i++) {
      const page = await runEvents(runId, 0);
      if (page.events.some((e) => e.kind === "tool.completed")) break;
      await wait(50);
    }
    await runInDurableObject(stub, (_instance, state) => state.abort("simulated eviction")).catch(() => undefined);
    await runDurableObjectAlarm(bindings.CONVERSATION.get(bindings.CONVERSATION.idFromName(conversationId)));
    const { status, events } = await a.finish(runId);
    expect(status).toBe("completed");
    expect(events.filter((e) => e.kind === "tool.started")).toHaveLength(1);
    const calls = await runInDurableObject(bindings.CONVERSATION.get(bindings.CONVERSATION.idFromName(conversationId)), (_i, state) => state.storage.sql.exec("select count(*) as n from wh_tool_call").one().n);
    expect(calls).toBe(1);
    const page = (await (await a.send(`/conversations/${conversationId}`)).json()) as { messages: { role: string }[] };
    expect(page.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("cancels a run", async () => {
    const a = await personWithRecords("a@example.test");
    const conversationId = await a.conversation();
    const { runId } = (await (await a.ask(conversationId, "[slow] long one")).json()) as { runId: string };
    await wait(300);
    expect((await a.send(`/runs/${runId}`, { method: "DELETE" })).status).toBe(202);
    const { status, events } = await a.finish(runId);
    expect(status).toBe("cancelled");
    expect(events.at(-1)?.kind).toBe("run.cancelled");
  });

  it("limits questions before recording anything", async () => {
    const a = await personWithRecords("a@example.test");
    const conversationId = await a.conversation();
    const limiter = bindings.RATE_LIMITER.get(bindings.RATE_LIMITER.idFromName(`questionPerMinute:${a.userId}`));
    for (let i = 0; i < LIMITS.questionPerMinute.limit; i++) await limiter.take(LIMITS.questionPerMinute.limit, LIMITS.questionPerMinute.windowMs);
    const refused = await a.ask(conversationId, "[plain] hi");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await chatDb(bindings).select().from(chat.chatRun)).toEqual([]);
  });

  it("lets demo guests ask about the demo chart, without keeping anything past a day or saving summaries", async () => {
    await ensureDemoChart(bindings, db, recordsKey);
    const guest = client(`${DEMO_GUEST_COOKIE}=${issueGuestViewer(env.BETTER_AUTH_SECRET!).cookie}`, "demo");
    const conversationId = await guest.conversation();
    const { runId } = (await (await guest.ask(conversationId, "[summary] what about eosinophils?")).json()) as { runId: string };
    const { status, events } = await guest.finish(runId);
    expect(status).toBe("completed");
    // save_summary isn't offered in the demo, so the model's attempt fails as an unknown tool.
    expect(events.filter((e) => e.kind === "tool.completed" && e.payload.tool === "save_summary" && e.payload.status === "completed")).toEqual([]);
    expect(await chatDb(bindings).select().from(chat.userSummary)).toEqual([]);
    const [row] = await chatDb(bindings).select().from(chat.chatConversation).where(eq(chat.chatConversation.id, conversationId));
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    // A personal tab can't reach the demo's conversations, or the other way round.
    expect((await client(guest.send.length ? `${DEMO_GUEST_COOKIE}=x` : "", "personal").send("/conversations")).status).toBe(401);
    expect((await guest.send("/conversations", { headers: { "x-wildhearts-workspace": "personal" } })).status).toBe(409);

    // A day later the sweep deletes the conversation and everything its object stored.
    await chatDb(bindings).update(chat.chatConversation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(chat.chatConversation.id, conversationId));
    const worker = (await import("../../src/chat")).default;
    await worker.scheduled({} as ScheduledController, bindings as never);
    expect(await chatDb(bindings).select().from(chat.chatConversation)).toEqual([]);
    const left = await runInDurableObject(bindings.CONVERSATION.get(bindings.CONVERSATION.idFromName(conversationId)), (_i, state) => state.storage.sql.exec("select count(*) as n from wh_message").one().n);
    expect(left).toBe(0);
  });
});
