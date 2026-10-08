import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { CHAT_MAX_CONTEXT_BYTES, CHAT_MAX_EVENT_BYTES, CHAT_MAX_REQUEST_BYTES, CHAT_MAX_TOOL_OUTPUT_BYTES, protocolEventSchema, toolInputSchema } from "./protocol.js";
import { CHAT_MAX_TOOL_REPLY_BYTES, ChatWebApi, ChatWebApiError } from "./web-api.js";
import type { ChatMessage, ToolName, WorkerEvent } from "./contracts.js";

const executionGrantPattern = /^whchat1\.execution\.[A-Za-z0-9_-]{43}$/;
const inferenceRequestLimit = 512 * 1024;
const inferenceStreamLimit = 4 * 1024 * 1024;
const inferenceTimeoutMs = 120_000;
const inferenceCancellationPollMs = 2_000;

export type PrivateGatewayOptions = Readonly<{
  api: ChatWebApi;
  inferenceUrl: URL;
  modelId: string;
  maxTokens: number;
  apiKey?: string;
  fetcher?: typeof fetch;
}>;

/** Private worker relay: execution grants authorize only web-owned run operations. */
export function createPrivateToolGateway(options: PrivateGatewayOptions) {
  const inferenceUrl = validateInferenceUrl(options.inferenceUrl);
  const fetcher = options.fetcher ?? fetch;
  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      sendJson(response, safeGatewayStatus(error), { error: "worker_gateway_unavailable" });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const executionGrant = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!executionGrant || !executionGrantPattern.test(executionGrant)) return sendJson(response, 401, { error: "unauthorized" });
    if (request.url === "/v1/worker/context" && request.method === "GET") {
      const context = await options.api.context(executionGrant);
      return sendBoundedJson(response, 200, context, CHAT_MAX_CONTEXT_BYTES);
    }
    if (request.url === "/v1/worker/cancellation" && request.method === "GET") {
      return sendJson(response, 200, { cancelled: await options.api.isCancelled(executionGrant) });
    }
    if (request.url === "/v1/tools" && request.method === "POST") {
      const body = toolInputSchema.parse(await readJsonBody(request, CHAT_MAX_REQUEST_BYTES));
      const result = await options.api.invokeTool(executionGrant, body);
      return sendBoundedJson(response, 200, result, CHAT_MAX_TOOL_REPLY_BYTES);
    }
    if (request.url === "/v1/worker/events" && request.method === "POST") {
      const event = protocolEventSchema.parse(await readJsonBody(request, CHAT_MAX_EVENT_BYTES));
      const result = await options.api.publishEvents(executionGrant, [event]);
      return sendJson(response, 202, result);
    }
    if (request.url === "/v1/inference/chat/completions" && request.method === "POST") {
      return streamInference(request, response, executionGrant);
    }
    return sendJson(response, 404, { error: "not_found" });
  }

  async function streamInference(request: IncomingMessage, response: ServerResponse, executionGrant: string): Promise<void> {
    const input = await readJsonBody(request, inferenceRequestLimit);
    if (!input || typeof input !== "object" || Array.isArray(input)) return sendJson(response, 400, { error: "invalid_inference_request" });
    const body = input as Record<string, unknown>;
    if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 64 || (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 16))) return sendJson(response, 400, { error: "invalid_inference_request" });
    if (await options.api.isCancelled(executionGrant)) return sendJson(response, 409, { error: "run_not_active" });

    const controller = new AbortController();
    const stop = () => controller.abort();
    request.once("aborted", stop);
    response.once("close", stop);
    const deadline = setTimeout(stop, inferenceTimeoutMs);
    let polling = false;
    const cancellationPoll = setInterval(() => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      void options.api.isCancelled(executionGrant).then((cancelled) => { if (cancelled) stop(); }).catch(stop).finally(() => { polling = false; });
    }, inferenceCancellationPollMs);
    const requestedTokens = typeof body.max_tokens === "number" && Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : options.maxTokens;
    const inferenceBody = {
      model: options.modelId,
      messages: body.messages,
      ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
      ...(body.tool_choice === undefined ? {} : { tool_choice: body.tool_choice }),
      stream: body.stream === true,
      ...(body.stream_options && typeof body.stream_options === "object" ? { stream_options: body.stream_options } : {}),
      max_tokens: Math.min(requestedTokens, options.maxTokens),
      ...(typeof body.temperature === "number" && Number.isFinite(body.temperature) ? { temperature: Math.max(0, Math.min(1, body.temperature)) } : {}),
    };
    try {
      const url = new URL("chat/completions", inferenceUrl);
      const upstream = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
        body: JSON.stringify(inferenceBody),
        redirect: "error",
        signal: controller.signal,
      });
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => undefined);
        if (!response.headersSent) sendJson(response, 502, { error: "inference_unavailable" });
        else response.end();
        return;
      }
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      if (!upstream.body) { response.end(); return; }
      const reader = upstream.body.getReader();
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done || controller.signal.aborted) break;
        bytes += value.byteLength;
        if (bytes > inferenceStreamLimit) { await reader.cancel().catch(() => undefined); controller.abort(); break; }
        response.write(Buffer.from(value));
      }
      response.end();
    } catch {
      if (!response.headersSent) sendJson(response, 502, { error: "inference_unavailable" });
      else response.end();
    } finally {
      clearTimeout(deadline);
      clearInterval(cancellationPoll);
      request.off("aborted", stop);
      response.off("close", stop);
    }
  }
}

function validateInferenceUrl(input: URL): URL {
  const url = new URL(input.toString());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid_chat_inference_url");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  request.setTimeout(5_000, () => request.destroy());
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBytes) throw new ChatWebApiError(413, "worker_request_too_large");
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ChatWebApiError(400, "invalid_worker_request"); }
}

function sendBoundedJson(response: ServerResponse, status: number, body: unknown, maxBytes: number): void {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) { sendJson(response, 502, { error: "worker_response_too_large" }); return; }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(serialized, "utf8") });
  response.end(serialized);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(serialized, "utf8") });
  response.end(serialized);
}

export function safeGatewayStatus(error: unknown): number {
  if (error instanceof z.ZodError) return 400;
  if (error instanceof ChatWebApiError) {
    if ([400, 401, 409, 413].includes(error.status)) return error.status;
  }
  return 502;
}

/** Client used only inside an Iggy worker, where URL and execution grant are injected. */
export class GatewayToolClient {
  private contextPromise?: Promise<Readonly<{ messages: ReadonlyArray<ChatMessage>; modelId: string }>>;

  constructor(private readonly url: URL, private readonly executionGrant: string) {}

  async execute(toolCallId: string, tool: ToolName, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const response = await this.post("/v1/tools", { toolCallId, tool, input }, signal);
    if (!response.ok) throw new Error("tool_gateway_rejected");
    return response.json();
  }

  async cancelled(signal: AbortSignal): Promise<boolean> {
    const response = await fetch(new URL("/v1/worker/cancellation", this.url), { headers: this.headers(), redirect: "error", signal });
    if (!response.ok) throw new Error("tool_gateway_rejected");
    const body = z.object({ cancelled: z.boolean() }).strict().parse(await response.json());
    return body.cancelled;
  }

  async loadContext(signal: AbortSignal): Promise<Readonly<{ messages: ReadonlyArray<ChatMessage>; modelId: string }>> {
    if (!this.contextPromise) {
      const request = this.fetchContext(signal);
      const cached = request.catch((error: unknown) => {
        if (this.contextPromise === cached) this.contextPromise = undefined;
        throw error;
      });
      this.contextPromise = cached;
    }
    return this.contextPromise;
  }

  private async fetchContext(signal: AbortSignal): Promise<Readonly<{ messages: ReadonlyArray<ChatMessage>; modelId: string }>> {
    const response = await fetch(new URL("/v1/worker/context", this.url), { headers: this.headers(), redirect: "error", signal });
    if (!response.ok) throw new Error("tool_gateway_rejected");
    const body = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }).strict()).min(1).max(64), modelId: z.string().min(1).max(200) }).strict().parse(await response.json());
    if (Buffer.byteLength(JSON.stringify(body.messages), "utf8") > CHAT_MAX_CONTEXT_BYTES) throw new Error("tool_gateway_rejected");
    return body;
  }

  async publish(event: WorkerEvent, signal: AbortSignal): Promise<"accepted" | "duplicate"> {
    const response = await this.post("/v1/worker/events", event, signal);
    if (response.status === 409) throw new Error("worker_event_out_of_order");
    if (!response.ok) throw new Error("tool_gateway_rejected");
    const result = z.object({ status: z.enum(["accepted", "duplicate"]) }).strict().parse(await response.json());
    return result.status;
  }

  private async post(path: string, value: unknown, signal: AbortSignal): Promise<Response> {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body, "utf8") > CHAT_MAX_EVENT_BYTES) throw new Error("worker_request_too_large");
    return fetch(new URL(path, this.url), { method: "POST", headers: { ...this.headers(), "content-type": "application/json" }, body, redirect: "error", signal });
  }

  private headers(): Record<string, string> { return { authorization: `Bearer ${this.executionGrant}` }; }
}
