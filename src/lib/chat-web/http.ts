import "server-only";
import { z } from "zod";
import { ChatAuthorityError } from "./protocol";
import { ChatUnavailableError } from "./runtime";
import { chatRequestDiagnostic, type ChatRequestContext } from "./logging";

export const privateHeaders = { "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };
export class ChatRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function json(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 256 * 1024) throw new ChatRequestError(413, "response_too_large");
  return new Response(body, { status, headers: { ...privateHeaders, "Content-Type": "application/json; charset=utf-8" } });
}
export function empty(): Response { return new Response(null, { status: 204, headers: privateHeaders }); }

/** Bound actual bytes, not an untrusted Content-Length header. */
export async function body(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ChatRequestError(415, "json_required");
  const reader = request.body?.getReader();
  if (!reader) throw new ChatRequestError(400, "invalid_request");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new ChatRequestError(413, "request_too_large"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function bearer(request: Request): string {
  const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_.-]{32,256})$/)?.[1];
  if (!token) throw new ChatRequestError(401, "unauthorized");
  return token;
}
export async function guarded(work: (requestId: string) => Promise<Response>, context?: ChatRequestContext): Promise<Response> {
  const diagnostic = chatRequestDiagnostic(context);
  let response: Response;
  try { response = await work(diagnostic.requestId); }
  catch (error) {
    response = errorResponse(error);
    diagnostic.failure(response.status, error);
  }
  response.headers.set("X-Chat-Request-Id", diagnostic.requestId);
  return response;
}

function errorResponse(error: unknown): Response {
  if (error instanceof ChatRequestError || error instanceof ChatAuthorityError) return json({ error: error.code }, error.status);
  if (error instanceof ChatUnavailableError) return json({ error: "chat_unavailable" }, 503);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "invalid_request" }, 400);
  if (error instanceof Error && "code" in error && error.code === "CHAT_RUN_BUSY") return json({ error: "conversation_busy" }, 409);
  if (error instanceof Error && "code" in error && error.code === "CHAT_INVALID_CURSOR") return json({ error: "invalid_cursor" }, 400);
  if (error instanceof Error && "code" in error && error.code === "CHAT_PAGE_TOO_LARGE") return json({ error: "response_too_large" }, 413);
  // Exceptions can contain connection strings, identifiers or health context.
  return json({ error: "chat_unavailable" }, 503);
}
