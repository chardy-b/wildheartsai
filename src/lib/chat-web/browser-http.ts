import "server-only";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { asUser } from "@/lib/db/rls";
import { chatRun } from "@/lib/db/schema";
import * as store from "@/lib/chat/store";
import { webChatRuntime } from "./runtime";
import { body, empty, guarded, json, ChatRequestError } from "./http";

const id = z.uuid();
const question = z.object({ message: z.string().trim().min(1).max(12_000) }).strict();
const eventKinds: Record<string, string> = { lifecycle: "run.started", "answer.delta": "answer.delta", "tool.started": "tool.started", "tool.completed": "tool.completed", "message.completed": "answer.completed", "summary.suggested": "tool.completed", completed: "run.completed", cancelled: "run.cancelled", error: "run.failed" };
let nextReapAt = 0;
let reaping: Promise<unknown> | undefined;

/** Cookies identify the caller; no browser token, remote user ID or VPS API origin. */
export function browserRequest(request: Request, path: string[]): Promise<Response> {
  return guarded(async () => {
    if (!["GET", "POST", "DELETE"].includes(request.method)) throw new ChatRequestError(405, "method_not_allowed");
    if (request.method !== "GET" && (request.headers.get("origin") !== new URL(appUrl()).origin || request.headers.get("sec-fetch-site") === "cross-site")) throw new ChatRequestError(403, "forbidden");
    const identity = await auth.api.getSession({ headers: request.headers });
    if (!identity || !identity.user.emailVerified) throw new ChatRequestError(401, "unauthorized");
    // Read bounded input before opening a database transaction or taking auth locks.
    const submittedInput = request.method === "POST" && path.length === 3 && path[0] === "conversations" && path[2] === "runs"
      ? { idempotencyKey: id.parse(request.headers.get("idempotency-key")), ...question.parse(await body(request)) }
      : undefined;
    const { dataDb, authority } = await webChatRuntime();
    // A periodic job is authoritative; coalesce status-read cleanup per server instance.
    if (request.method === "GET" && Date.now() >= nextReapAt) {
      reaping ??= authority.reap().then(() => { nextReapAt = Date.now() + 15_000; }).finally(() => { reaping = undefined; });
      await reaping;
    }
    return asUser(dataDb, identity.user.id, async (tx) => {
      const locked = await tx.execute(sql`select public.chat_lock_session(${identity.session.id}, ${identity.user.id}) at time zone 'UTC' as expires_at`) as unknown as { rows: { expires_at: Date | string | null }[] };
      if (!locked.rows[0]?.expires_at || !Number.isFinite(new Date(locked.rows[0].expires_at).getTime()) || new Date(locked.rows[0].expires_at).getTime() <= Date.now()) throw new ChatRequestError(401, "unauthorized");
      const sessionExpiresAt = new Date(locked.rows[0].expires_at).getTime();
      const response = await (async () => {
      const scope = { userId: identity.user.id };
      const [area, resourceId, operation] = path;
      if (path.length > 3) throw new ChatRequestError(404, "not_found");
      const url = new URL(request.url);
      const cursorValue = url.searchParams.get("before");
      const cursor = cursorValue === null || path.length !== 1 ? undefined : id.parse(cursorValue);
      if (area === "conversations" && path.length === 1) {
        if (request.method === "GET") return json(await store.listConversationPage(tx, scope, { cursor }));
        if (request.method === "POST") return json({ conversation: await store.createConversation(tx, scope) }, 201);
      }
      if (area === "summaries" && path.length === 1 && request.method === "GET") return json(await store.listSummaryPage(tx, scope, { cursor }));
      if (resourceId) id.parse(resourceId);
      if (area === "summaries" && path.length === 2 && request.method === "DELETE") {
        if (!(await store.deleteSummary(tx, scope, resourceId))) throw new ChatRequestError(404, "not_found");
        return empty();
      }
      if (area === "conversations" && resourceId) {
        const owned = { ...scope, conversationId: resourceId };
        const conversation = await store.getConversation(tx, owned);
        if (!conversation) throw new ChatRequestError(404, "not_found");
        if (path.length === 2 && request.method === "GET") {
          const rawBefore = url.searchParams.get("before");
          if (rawBefore !== null && (!/^[1-9][0-9]*$/.test(rawBefore) || !Number.isSafeInteger(Number(rawBefore)))) throw new ChatRequestError(400, "invalid_cursor");
          const before = rawBefore === null ? undefined : Number(rawBefore);
          const page = await store.listMessagePage(tx, owned, { before });
          return json({ conversation, ...page, runs: await store.listRunsForMessages(tx, owned, page.messages.map(message => message.id), { includeActive: before === undefined }) });
        }
        if (path.length === 2 && request.method === "DELETE") { await store.deleteConversation(tx, owned); return empty(); }
        if (operation === "runs" && request.method === "POST") {
          const { idempotencyKey, message } = submittedInput!;
          // A user may have multiple tabs/conversations, so serialize their queue budget.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope.userId}, 918372))`);
          const prior = await tx.select({ id: chatRun.id }).from(chatRun).where(and(eq(chatRun.userId, scope.userId), eq(chatRun.idempotencyKey, idempotencyKey))).limit(1);
          const [queued] = await tx.select({ total: count() }).from(chatRun).where(and(eq(chatRun.userId, scope.userId), inArray(chatRun.status, ["queued", "running"])));
          if (!prior.length && queued.total >= 3) throw new ChatRequestError(429, "queue_limit");
          const submitted = await store.submitQuestionAndRun(tx, owned, { message, idempotencyKey, initiatingSessionId: identity.session.id });
          return json({ runId: submitted.run.id, status: submitted.run.status, created: !submitted.duplicate }, 202);
        }
      }
      if (area === "runs" && resourceId) {
        const run = await store.findRunForUser(tx, scope, resourceId);
        if (!run) throw new ChatRequestError(404, "not_found");
        const owned = { ...scope, conversationId: run.conversationId, runId: run.id };
        if (request.method === "DELETE" && path.length === 2) {
          const accepted = await store.requestRunCancellation(tx, owned);
          return json({ status: accepted ? "cancelling" : run.status }, 202);
        }
        if (request.method === "GET" && operation === "research-sources") {
          const rawAfter = new URL(request.url).searchParams.get("after");
          if (rawAfter !== null && (!/^[1-9][0-9]*$/.test(rawAfter) || !Number.isSafeInteger(Number(rawAfter)))) throw new ChatRequestError(400, "invalid_cursor");
          return json(await store.listResearchToolPage(tx, owned, { after: rawAfter === null ? undefined : Number(rawAfter) }));
        }
        if (request.method === "GET" && operation === "events") {
          const raw = new URL(request.url).searchParams.get("after") ?? "0";
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ChatRequestError(400, "invalid_event_id");
          const after = Number(raw);
          const saved = await store.listEventsAfter(tx, owned, after);
          const events = saved.map((event) => ({ sequence: event.sequence, kind: eventKinds[event.type] ?? "tool.completed", payload: ["completed", "cancelled", "error"].includes(event.type) ? { status: event.type === "completed" ? "completed" : event.type === "cancelled" ? "cancelled" : "failed" } : event.type === "message.completed" ? {} : event.data, createdAt: event.createdAt }));
          return json({ events, status: run.status, nextSequence: events.at(-1)?.sequence ?? after });
        }
      }
      throw new ChatRequestError(404, "not_found");
      })();
      // Expiry can pass while decrypting a bounded response; roll back and discard it.
      if (sessionExpiresAt <= Date.now()) throw new ChatRequestError(401, "unauthorized");
      return response;
    });
  });
}
