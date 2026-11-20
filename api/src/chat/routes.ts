import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ChatIdentity } from "../data/chat-records";
import { allow, clientIp, type LimitName } from "../limits";
import { ChatRequestError, type ChatBindings } from "./env";
import { createConversation, deleteConversation, listConversations, ownedConversation as ownedConversationRow, ownedRun as ownedRunRow, recordRun, type ConversationRow } from "./data/conversations";
import { deleteSummary, summaryPage } from "./data/summaries";

// The browser's chat API (`/api/chat/v1/*`), the same paths and answers as the Next app's
// (src/lib/chat-web/browser-http.ts). The browser's cookies identify the caller through the
// records RPC; nothing in a request picks a person. Conversation content is in each
// conversation's Durable Object; CHAT_DB has the lists.

type Vars = { identity: ChatIdentity; ownerId: string };
export const chatRoutes = new Hono<{ Bindings: ChatBindings; Variables: Vars }>().basePath("/api/chat/v1");

const PRIVATE = { "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };
const id = z.uuid();
const question = z.object({ message: z.string().trim().min(1).max(12_000) }).strict();
const DEMO_TTL_MS = 24 * 60 * 60 * 1000;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: PRIVATE });
const empty = () => new Response(null, { status: 204, headers: PRIVATE });

chatRoutes.onError((error) => {
  if (error instanceof ChatRequestError && "response" in error) return error.response as Response;
  if (error instanceof ChatRequestError) return json({ error: error.code }, error.status);
  // Errors cross a Durable Object's RPC as plain errors: the known codes keep their status.
  const known: Record<string, number> = { not_found: 404, conversation_busy: 409, chat_unavailable: 503 };
  if (error instanceof Error && error.message in known) return json({ error: error.message }, known[error.message]);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "invalid_request" }, 400);
  // Exceptions can carry identifiers or health context: none of it goes out.
  console.error("[chat] request failed", error instanceof Error ? error.name : "unknown");
  return json({ error: "chat_unavailable" }, 503);
});

chatRoutes.use("*", async (c, next) => {
  if (c.env.CHAT_ENABLED !== "1") throw new ChatRequestError(503, "chat_unavailable");
  const request = c.req.raw;
  if (!["GET", "POST", "DELETE"].includes(request.method)) throw new ChatRequestError(405, "method_not_allowed");
  if (request.method !== "GET" && (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site")) throw new ChatRequestError(403, "forbidden");
  const identity = await c.env.RECORDS.identify(request.headers.get("cookie") ?? "");
  if (!identity) throw new ChatRequestError(401, "unauthorized");
  // Pin chat history and writes to the workspace this tab rendered (personal or demo).
  const expected = request.headers.get("x-wildhearts-workspace");
  const contextRead = /\/v1\/(conversations|summaries)$/.test(new URL(request.url).pathname);
  if (expected !== null || request.method !== "GET" || contextRead) {
    if ((expected ?? "personal") !== (identity.demo ? "demo" : "personal")) throw new ChatRequestError(409, "workspace_changed");
  }
  c.set("identity", identity);
  // A demo viewer's conversations are theirs alone, and kept a day.
  c.set("ownerId", identity.demo ? `demo:${identity.demo.viewerId}` : identity.userId);
  await next();
});

type C = Context<{ Bindings: ChatBindings; Variables: Vars }>;
const conversationObject = (c: C, conversationId: string) => c.env.CONVERSATION.get(c.env.CONVERSATION.idFromName(conversationId));

async function limited(c: C, checks: [LimitName, string][]) {
  const outcome = await allow(c.env, checks);
  if (!outcome.ok) {
    const response = json({ error: "rate_limited" }, 429);
    response.headers.set("Retry-After", String(outcome.retryAfterSeconds));
    throw Object.assign(new ChatRequestError(429, "rate_limited"), { response });
  }
}

async function ownedConversation(c: C, conversationId: string) {
  const row = await ownedConversationRow(c.env, c.get("ownerId"), id.parse(conversationId));
  if (!row) throw new ChatRequestError(404, "not_found");
  return row;
}

async function ownedRun(c: C, runId: string) {
  const row = await ownedRunRow(c.env, c.get("ownerId"), id.parse(runId));
  if (!row) throw new ChatRequestError(404, "not_found");
  return row;
}

const view = (row: ConversationRow) => ({ id: row.id, title: row.title, archivedAt: null, createdAt: row.createdAt, updatedAt: row.updatedAt });

chatRoutes.get("/conversations", async (c) => {
  const cursor = c.req.query("before");
  const page = await listConversations(c.env, c.get("ownerId"), cursor === undefined ? undefined : id.parse(cursor));
  if (!page) throw new ChatRequestError(400, "invalid_cursor");
  return json({ conversations: page.rows.map(view), hasMore: page.hasMore, nextCursor: page.hasMore ? page.rows.at(-1)!.id : null });
});

chatRoutes.post("/conversations", async (c) => {
  const identity = c.get("identity"), ownerId = c.get("ownerId");
  await limited(c, [["conversationPerPerson", ownerId]]);
  const conversationId = crypto.randomUUID();
  const expiresAt = identity.demo ? new Date(Date.now() + DEMO_TTL_MS) : null;
  await conversationObject(c, conversationId).init({ conversationId, ownerId, recordsUserId: identity.userId, demo: identity.demo !== null, expiresAt: expiresAt?.getTime() ?? null });
  const row = await createConversation(c.env, { id: conversationId, ownerId, recordsUserId: identity.userId, expiresAt });
  return json({ conversation: view(row) }, 201);
});

chatRoutes.get("/summaries", async (c) => {
  const cursor = c.req.query("before");
  const page = await summaryPage(c.env, c.get("ownerId"), c.get("identity").userId, cursor === undefined ? undefined : id.parse(cursor));
  if (!page) throw new ChatRequestError(400, "invalid_cursor");
  return json(page);
});

chatRoutes.delete("/summaries/:id", async (c) => {
  if (!(await deleteSummary(c.env, c.get("ownerId"), id.parse(c.req.param("id"))))) throw new ChatRequestError(404, "not_found");
  return empty();
});

chatRoutes.get("/conversations/:id", async (c) => {
  const conversation = await ownedConversation(c, c.req.param("id"));
  const raw = c.req.query("before");
  if (raw !== undefined && (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)))) throw new ChatRequestError(400, "invalid_cursor");
  const page = await conversationObject(c, conversation.id).messagePage(raw === undefined ? undefined : Number(raw));
  return json({ conversation: view(conversation), ...page });
});

chatRoutes.delete("/conversations/:id", async (c) => {
  const conversation = await ownedConversation(c, c.req.param("id"));
  await conversationObject(c, conversation.id).destroy();
  await deleteConversation(c.env, c.get("ownerId"), conversation.id);
  return empty();
});

chatRoutes.post("/conversations/:id/runs", async (c) => {
  const identity = c.get("identity"), ownerId = c.get("ownerId");
  const conversation = await ownedConversation(c, c.req.param("id"));
  const idempotencyKey = id.parse(c.req.header("idempotency-key"));
  if (!c.req.header("content-type")?.startsWith("application/json")) throw new ChatRequestError(415, "json_required");
  const text = await c.req.text();
  if (text.length > 64 * 1024) throw new ChatRequestError(413, "request_too_large");
  const { message } = question.parse(JSON.parse(text));
  // Counted before anything is recorded or any model is asked.
  await limited(c, [
    [identity.demo?.viewer === "guest" ? "questionPerGuest" : "questionPerPerson", ownerId],
    ["questionPerMinute", ownerId],
    ...(identity.demo?.viewer === "guest" ? [["questionPerNetwork", clientIp(c.req.raw.headers)] as [LimitName, string]] : []),
  ]);
  const runId = crypto.randomUUID();
  const expiresAt = identity.demo ? Date.now() + DEMO_TTL_MS : null;
  const submitted = await conversationObject(c, conversation.id).submit({ runId, idempotencyKey, message, fence: identity.fence, expiresAt });
  if (submitted.created) await recordRun(c.env, ownerId, conversation, submitted.runId, message, expiresAt ? new Date(expiresAt) : null);
  return json(submitted, 202);
});

chatRoutes.delete("/runs/:id", async (c) => {
  const run = await ownedRun(c, c.req.param("id"));
  return json({ status: await conversationObject(c, run.conversationId).cancel(run.id) }, 202);
});

chatRoutes.get("/runs/:id/events", async (c) => {
  const run = await ownedRun(c, c.req.param("id"));
  const raw = c.req.query("after") ?? "0";
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ChatRequestError(400, "invalid_event_id");
  return json(await conversationObject(c, run.conversationId).events(run.id, Number(raw)));
});

// What the answer was based on, as it was read: the records RPC turns the run's receipts into
// views, and leaves out anything that has changed since.
chatRoutes.get("/runs/:id/record-sources", async (c) => {
  const run = await ownedRun(c, c.req.param("id"));
  const raw = c.req.query("after");
  if (raw !== undefined && (!/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) > 600)) throw new ChatRequestError(400, "invalid_cursor");
  const after = raw === undefined ? 0 : Number(raw);
  const receipts = await conversationObject(c, run.conversationId).receipts(run.id);
  const selected = receipts.slice(after, after + 8);
  const sources = selected.length ? await c.env.RECORDS.recordSources(c.get("identity").userId, selected) : [];
  const next = after + selected.length;
  return json({ sources, hasMore: next < receipts.length, nextAfter: next < receipts.length ? next : null });
});

chatRoutes.get("/runs/:id/research-sources", async (c) => {
  const run = await ownedRun(c, c.req.param("id"));
  const raw = c.req.query("after");
  if (raw !== undefined && (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 6)) throw new ChatRequestError(400, "invalid_cursor");
  return json(await conversationObject(c, run.conversationId).researchPage(run.id, raw === undefined ? undefined : Number(raw)));
});

chatRoutes.all("*", () => json({ error: "not_found" }, 404));
