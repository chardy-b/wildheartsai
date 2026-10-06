import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { verifyRunnerCapability } from "./capabilities.js";
import type { ChatRepository, ToolName } from "./contracts.js";

const toolRequest = z.object({
  // Providers (especially llama.cpp templates) commonly use IDs like call_abc123.
  // Storage maps this untrusted provider identifier to its own opaque primary key.
  toolCallId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  tool: z.enum(["get_data_coverage", "find_records", "read_records", "read_stored_note", "calculate_lab_trend", "find_saved_summaries", "save_summary"]),
  input: z.record(z.string(), z.unknown()),
});
const workerEvent = z.object({
  eventId: z.string().uuid(),
  sequence: z.number().int().positive(),
  type: z.enum(["lifecycle", "answer.delta", "message.completed", "tool.started", "tool.completed", "summary.suggested", "completed", "cancelled", "error"]),
  data: z.record(z.string(), z.unknown()),
});

async function jsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
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

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/**
 * This listener belongs on a private Docker network. It accepts only a short-lived
 * run capability and derives all ownership from it; user IDs in a tool body are ignored.
 */
export function createPrivateToolGateway(options: { repository: ChatRepository; runnerKey: Uint8Array; issuer: string; modelId?: string; modelProxy?: (input: { path: string; body: unknown; signal: AbortSignal }) => Promise<Response> }) {
  return createServer(async (request, response) => {
    try {
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const scope = bearer ? await verifyRunnerCapability(bearer, options.runnerKey, options.issuer) : null;
    if (!scope) return send(response, 401, { error: "unauthorized" });
    // Fencing rejects a recovered worker's old capability before it can read context,
    // invoke tools, append events, or save a duplicate summary.
    const eventRoute = request.method === "POST" && request.url === "/v1/worker/events";
    // The atomic terminal helper alone accepts exact duplicate completions after
    // the lease ended. Ordinary events and every data-bearing call stay fenced.
    if (!eventRoute && request.url !== "/v1/worker/cancellation" && (!(await options.repository.isWorkerLeaseCurrent(scope)) || await options.repository.isCancellationRequested(scope))) return send(response, 409, { error: "run_not_active" });
    if (request.method === "POST" && request.url === "/v1/inference/chat/completions" && options.modelProxy) {
      try {
        const body = await jsonBody(request, 512 * 1024);
        const controller = new AbortController();
        const stop = () => controller.abort();
        response.once("close", stop);
        const cancellation = setInterval(() => {
          void Promise.all([options.repository.isWorkerLeaseCurrent(scope), options.repository.isCancellationRequested(scope)]).then(([active, cancelled]) => { if (!active || cancelled) controller.abort(); }).catch(stop);
        }, 1_000);
        try {
        const upstream = await options.modelProxy({ path: request.url.slice("/v1/inference".length), body, signal: controller.signal });
        response.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => ["content-type", "cache-control"].includes(name.toLowerCase()))));
        if (upstream.body) for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) response.write(chunk);
        return response.end();
        } finally { clearInterval(cancellation); response.off("close", stop); }
      } catch {
        if (response.headersSent) return response.end();
        return send(response, 502, { error: "inference_unavailable" });
      }
    }
    if (request.url?.startsWith("/v1/inference/")) return send(response, 404, { error: "not_found" });
    if (request.method === "GET" && request.url === "/v1/worker/context") return send(response, 200, { messages: await options.repository.loadRunContext(scope), modelId: options.modelId });
    if (request.method === "GET" && request.url === "/v1/worker/cancellation") return send(response, 200, { cancelled: !(await options.repository.isWorkerLeaseCurrent(scope)) || await options.repository.isCancellationRequested(scope) });
    if (request.method === "POST" && request.url === "/v1/worker/events") {
      try {
        const event = workerEvent.parse(await jsonBody(request));
        const terminal = event.type === "completed" || event.type === "cancelled" || event.type === "error";
        if (!terminal && (!(await options.repository.isWorkerLeaseCurrent(scope)) || await options.repository.isCancellationRequested(scope))) return send(response, 409, { error: "run_not_active" });
        if (event.type === "completed") {
          const answer = typeof event.data.answer === "string" ? event.data.answer : undefined;
          if (answer === undefined || answer.length < 1 || answer.length > 12_000) return send(response, 400, { error: "invalid_completion" });
          await options.repository.finalizeWorkerEvent(scope, event, { status: "completed", answer });
        }
        else if (event.type === "cancelled") await options.repository.finalizeWorkerEvent(scope, event, { status: "cancelled" });
        else if (event.type === "error") await options.repository.finalizeWorkerEvent(scope, event, { status: "failed" });
        else {
          const outcome = await options.repository.appendWorkerEvent(scope, event);
          return send(response, outcome === "out_of_order" ? 409 : 202, { status: outcome });
        }
        return send(response, 202, { status: "accepted" });
      } catch {
        return send(response, 400, { error: "invalid_worker_event" });
      }
    }
    if (request.method !== "POST" || request.url !== "/v1/tools") return send(response, 404, { error: "not_found" });
    try {
      const parsed = toolRequest.parse(await jsonBody(request));
      const result = await options.repository.invokeTool(scope, parsed);
      return send(response, 200, result);
    } catch {
      // Validation output and errors are deliberately generic because the body may contain health data.
      return send(response, 400, { error: "invalid_tool_request" });
    }
    } catch {
      // Node does not observe rejected async request listeners. Contain every
      // verification/repository failure without serializing protected error text.
      if (response.headersSent) return response.end();
      return send(response, 503, { error: "gateway_unavailable" });
    }
  });
}

export class GatewayToolClient {
  constructor(private readonly url: URL, private readonly capability: string) {}

  async execute(toolCallId: string, tool: ToolName, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(new URL("/v1/tools", this.url), {
      method: "POST",
      headers: { authorization: `Bearer ${this.capability}`, "content-type": "application/json" },
      body: JSON.stringify({ toolCallId, tool, input }),
      signal,
    });
    if (!response.ok) throw new Error("tool_gateway_rejected");
    return response.json();
  }

  async cancelled(signal: AbortSignal): Promise<boolean> {
    const response = await fetch(new URL("/v1/worker/cancellation", this.url), { headers: { authorization: `Bearer ${this.capability}` }, signal });
    if (!response.ok) throw new Error("tool_gateway_rejected");
    const body = await response.json() as { cancelled?: unknown };
    return body.cancelled === true;
  }

  async loadContext(signal: AbortSignal): Promise<ReadonlyArray<Readonly<{ role: "user" | "assistant"; content: string }>>> {
    const response = await fetch(new URL("/v1/worker/context", this.url), { headers: { authorization: `Bearer ${this.capability}` }, signal });
    if (!response.ok) throw new Error("tool_gateway_rejected");
    const body = await response.json() as { messages?: unknown };
    return z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).parse(body.messages);
  }

  async loadConfiguration(signal: AbortSignal): Promise<{ modelId: string }> {
    const response = await fetch(new URL("/v1/worker/context", this.url), { headers: { authorization: `Bearer ${this.capability}` }, signal });
    if (!response.ok) throw new Error("tool_gateway_rejected");
    return z.object({ modelId: z.string().min(1).max(200) }).parse(await response.json());
  }

  async publish(event: { eventId: string; sequence: number; type: import("./contracts.js").WorkerEventType; data: Record<string, unknown> }, signal: AbortSignal): Promise<"accepted" | "duplicate"> {
    const response = await fetch(new URL("/v1/worker/events", this.url), {
      method: "POST",
      headers: { authorization: `Bearer ${this.capability}`, "content-type": "application/json" },
      body: JSON.stringify(event), signal,
    });
    if (response.status === 409) throw new Error("worker_event_out_of_order");
    if (!response.ok) throw new Error("tool_gateway_rejected");
    const body = await response.json() as { status?: unknown };
    if (body.status !== "accepted" && body.status !== "duplicate") throw new Error("tool_gateway_rejected");
    return body.status;
  }
}
