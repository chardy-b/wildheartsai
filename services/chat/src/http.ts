import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { CapabilityVerifier, ChatRepository, ChatScope, PublicCapability } from "./contracts.js";

const createRunBody = z.object({ message: z.string().trim().min(1).max(12_000) });
const lastEventId = z.string().regex(/^\d+$/);
const basicScope = (ticket: PublicCapability) => ({ userId: ticket.userId, credentialId: ticket.credentialId, expiresAt: ticket.expiresAt });
const runScope = (ticket: PublicCapability, conversationId: string, runId?: string): ChatScope => ({ ...basicScope(ticket), conversationId, runId });

async function jsonBody(request: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  const buffers: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBytes) throw new Error("body_too_large");
    buffers.push(value);
  }
  return JSON.parse(Buffer.concat(buffers).toString("utf8"));
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", pragma: "no-cache" });
  response.end(JSON.stringify(value));
}

function setCors(request: IncomingMessage, response: ServerResponse, webOrigin: string): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // non-browser callers still require a capability.
  if (origin !== webOrigin) return false;
  response.setHeader("access-control-allow-origin", webOrigin);
  response.setHeader("access-control-allow-credentials", "false");
  response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization, content-type, idempotency-key, last-event-id");
  response.setHeader("vary", "Origin");
  return true;
}

function ticketFrom(request: IncomingMessage, verifier: CapabilityVerifier): Promise<PublicCapability | null> {
  const token = request.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
  return token ? verifier.verify(token) : Promise.resolve(null);
}

function serialiseDate<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type ChatHttpOptions = Readonly<{ repository: ChatRepository; verifier: CapabilityVerifier; webOrigin: string; streamPollMs?: number; onCancel?: (runId: string) => Promise<void> }>;

/** Public VPS API. It never accepts a user ID: verified ticket + ownership-scoped repository calls bind identity. */
export function createChatHttpServer(options: ChatHttpOptions) {
  const pollMs = options.streamPollMs ?? 1_000;
  return createServer(async (request, response) => {
    try {
    if (!setCors(request, response, options.webOrigin)) return send(response, 403, { error: "origin_not_allowed" });
    if (request.method === "OPTIONS") { response.writeHead(204); return response.end(); }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { status: "ok" });
    const ticket = await ticketFrom(request, options.verifier);
    if (!ticket) return send(response, 401, { error: "unauthorized" });

    const conversationMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
    const runMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/runs$/);
    const eventMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
    const cancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
    const summaryMatch = url.pathname.match(/^\/v1\/summaries\/([^/]+)$/);

      if (request.method === "GET" && url.pathname === "/v1/conversations") return send(response, 200, { conversations: serialiseDate(await options.repository.listConversations(basicScope(ticket))) });
      if (request.method === "POST" && url.pathname === "/v1/conversations") return send(response, 201, { conversation: serialiseDate(await options.repository.createConversation(basicScope(ticket))) });
      if (request.method === "GET" && conversationMatch) {
        const conversation = await options.repository.getConversation(runScope(ticket, conversationMatch[1]));
        return conversation ? send(response, 200, serialiseDate(conversation)) : send(response, 404, { error: "not_found" });
      }
      if (request.method === "DELETE" && conversationMatch) {
        const deleted = await options.repository.deleteConversation(runScope(ticket, conversationMatch[1]));
        return deleted ? send(response, 204, undefined) : send(response, 404, { error: "not_found" });
      }
      if (request.method === "POST" && runMatch) {
        const idempotencyKey = request.headers["idempotency-key"];
        if (!z.string().uuid().safeParse(idempotencyKey).success || typeof idempotencyKey !== "string") return send(response, 400, { error: "idempotency_key_required" });
        const body = createRunBody.parse(await jsonBody(request));
        const created = await options.repository.createRun({ scope: runScope(ticket, runMatch[1]), idempotencyKey, message: body.message });
        return send(response, 202, { runId: created.runId, status: "queued", created: created.created });
      }
      if (request.method === "GET" && eventMatch) return await streamEvents(request, response, ticket, eventMatch[1], options, url, pollMs);
      if (request.method === "DELETE" && cancelMatch) {
        const run = await options.repository.findRunForUser(basicScope(ticket), cancelMatch[1]);
        if (!run) return send(response, 404, { error: "not_found" });
        const accepted = await options.repository.requestCancellation(runScope(ticket, run.conversationId, run.id));
        // Cancellation is already durable. A temporarily unavailable daemon must
        // not make the browser think its cancellation request failed.
        if (accepted) await options.onCancel?.(run.id).catch(() => undefined);
        return send(response, 202, { status: accepted ? "cancelling" : run.status });
      }
      if (request.method === "GET" && url.pathname === "/v1/summaries") return send(response, 200, { summaries: serialiseDate(await options.repository.listSummaries(basicScope(ticket))) });
      if (request.method === "DELETE" && summaryMatch) {
        const deleted = await options.repository.deleteSummary(basicScope(ticket), summaryMatch[1]);
        return deleted ? send(response, 204, undefined) : send(response, 404, { error: "not_found" });
      }
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "CHAT_RUN_BUSY") return send(response, 409, { error: "conversation_busy" });
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large") return send(response, 400, { error: "invalid_request" });
      // Errors are intentionally not logged or returned because they can include protected content.
      if (response.headersSent) return response.end();
      return send(response, 500, { error: "internal_error" });
    }
  });
}

async function streamEvents(request: IncomingMessage, response: ServerResponse, ticket: PublicCapability, runId: string, options: ChatHttpOptions, url: URL, pollMs: number): Promise<void> {
  const run = await options.repository.findRunForUser(basicScope(ticket), runId);
  if (!run) return send(response, 404, { error: "not_found" });
  const scope = runScope(ticket, run.conversationId, run.id);
  const headerId = Array.isArray(request.headers["last-event-id"]) ? request.headers["last-event-id"][0] : request.headers["last-event-id"];
  const fromQuery = url.searchParams.get("after");
  const supplied = headerId ?? fromQuery ?? "0";
  if (!lastEventId.safeParse(supplied).success) return send(response, 400, { error: "invalid_event_id" });
  let sequence = Number(supplied);
  if (!Number.isSafeInteger(sequence)) return send(response, 400, { error: "invalid_event_id" });
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  response.flushHeaders();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let publishing = false;
  const stop = () => { stopped = true; if (timer) clearInterval(timer); response.end(); };
  // IncomingMessage closes after a request body is consumed; ServerResponse close is the
  // client-disconnect signal for an SSE response.
  response.once("close", stop);
  const publish = async () => {
    if (stopped || publishing) return;
    publishing = true;
    try {
    // Revalidating on every poll makes session revocation effective for a live stream.
    const current = await options.verifier.verify(request.headers.authorization?.replace(/^Bearer\s+/, "") ?? "");
    if (!current || current.userId !== ticket.userId || current.sessionId !== ticket.sessionId) return stop();
    // Read terminal state before its events. If finalization commits between
    // these reads, the next poll closes; a completed state can never close a
    // stream before its atomically committed terminal event has been fetched.
    const latest = await options.repository.getRun(scope, runId);
    const events = await options.repository.listEvents(scope, sequence);
    for (const event of events) {
      response.write(`id: ${event.sequence}\nevent: chat\ndata: ${JSON.stringify(serialiseDate(event))}\n\n`);
      sequence = event.sequence;
    }
    if (events.length === 0) response.write(": keepalive\n\n");
    if (!latest || ["completed", "failed", "cancelled", "interrupted"].includes(latest.status)) stop();
    } finally { publishing = false; }
  };
  await publish();
  if (!stopped) timer = setInterval(() => void publish().catch(stop), pollMs);
}
