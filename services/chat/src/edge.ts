import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { researchReadOutputSchema, researchSearchOutputSchema } from "./protocol.js";
import type { OfflineResearchCorpus } from "./private-gateway.js";
import { ResearchCorpusError } from "./research-corpus.js";

// The VPS's edge service for chat on Cloudflare (CHAT_SERVICE_MODE=edge): each conversation's
// Durable Object runs the Pi agent itself and comes here only for model inference and the offline
// research corpus. One token (only its SHA-256 is configured here) authorizes the chat Worker; no
// record, person or conversation reaches this service except the context sent to the model.
// See "Cloudflare topology" in docs/superpowers/specs/2026-10-07-web-owned-chat-security-boundary.md.

const REQUEST_LIMIT = 512 * 1024;
const ATTEMPT_TIMEOUT_MS = 120_000;
const RETRYABLE = new Set([404, 408, 429, 500, 502, 503, 504]);

export type EdgeOptions = Readonly<{
  tokenHash: string;
  inferenceUrl: URL;
  modelIds: readonly string[];
  maxTokens: number;
  apiKey?: string;
  researchCorpus?: OfflineResearchCorpus;
  fetcher?: typeof fetch;
}>;

const searchInput = z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(5).default(5) }).strict();
const readInput = z.object({ snapshotId: z.string().regex(/^[a-f0-9]{64}$/), sourceId: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(0).max(10_000_000).default(0), limit: z.number().int().min(1).max(12_000).default(12_000) }).strict();

export function createEdgeService(options: EdgeOptions) {
  if (!/^[a-f0-9]{64}$/.test(options.tokenHash)) throw new Error("invalid_chat_edge_token_hash");
  if (!options.modelIds.length) throw new Error("invalid_chat_inference_model");
  const expected = Buffer.from(options.tokenHash, "hex");
  const fetcher = options.fetcher ?? fetch;

  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (response.headersSent) response.end();
      else send(response, 502, { error: "edge_unavailable" });
    });
  });

  function authorized(request: IncomingMessage): boolean {
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]{32,256})$/)?.[1];
    if (!token) return false;
    return timingSafeEqual(createHash("sha256").update(token).digest(), expected);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (!authorized(request)) return send(response, 401, { error: "unauthorized" });
    if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });
    if (request.url === "/v1/inference/chat/completions") return inference(request, response);
    if (request.url === "/v1/research/search" || request.url === "/v1/research/read") return research(request, response, request.url.endsWith("search") ? "search" : "read");
    return send(response, 404, { error: "not_found" });
  }

  // The configured model only, whatever the request names; tokens capped; a fallback model is
  // tried when one fails before sending anything.
  async function inference(request: IncomingMessage, response: ServerResponse) {
    const input = (await readJson(request)) as Record<string, unknown> | null;
    if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 128 || (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 16))) {
      return send(response, 400, { error: "invalid_inference_request" });
    }
    const requested = typeof input.max_tokens === "number" && Number.isSafeInteger(input.max_tokens) && input.max_tokens > 0 ? input.max_tokens : options.maxTokens;
    const body = {
      messages: input.messages,
      ...(Array.isArray(input.tools) ? { tools: input.tools } : {}),
      ...(input.tool_choice === undefined ? {} : { tool_choice: input.tool_choice }),
      stream: input.stream === true,
      ...(input.stream_options && typeof input.stream_options === "object" ? { stream_options: input.stream_options } : {}),
      max_tokens: Math.min(requested, options.maxTokens),
      ...(typeof input.temperature === "number" && Number.isFinite(input.temperature) ? { temperature: Math.max(0, Math.min(1, input.temperature)) } : {}),
      // Qwen-style thinking budget, when the agent asks for one.
      ...(typeof input.thinking_budget === "number" && Number.isSafeInteger(input.thinking_budget) ? { thinking_budget: Math.min(input.thinking_budget, 4096) } : {}),
    };
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    for (const [index, model] of options.modelIds.entries()) {
      const attempt = AbortSignal.any([controller.signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
      let upstream: Response;
      try {
        upstream = await fetcher(new URL("chat/completions", options.inferenceUrl), {
          method: "POST", redirect: "error", signal: attempt,
          headers: { "content-type": "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
          body: JSON.stringify({ ...body, model }),
        });
      } catch {
        if (controller.signal.aborted) return;
        if (index + 1 < options.modelIds.length) continue;
        return send(response, 502, { error: "inference_unavailable" });
      }
      if (!upstream.ok || !upstream.body) {
        if (RETRYABLE.has(upstream.status) && index + 1 < options.modelIds.length) continue;
        return send(response, 502, { error: "inference_unavailable" });
      }
      response.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
      const reader = upstream.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        response.write(chunk.value);
      }
      return response.end();
    }
  }

  async function research(request: IncomingMessage, response: ServerResponse, operation: "search" | "read") {
    const corpus = options.researchCorpus;
    if (!corpus) return send(response, 503, { errorCode: "research_unavailable" });
    const raw = await readJson(request);
    try {
      if (operation === "search") {
        const input = searchInput.parse(raw);
        const { snapshotId } = await corpus.captureSnapshot();
        return send(response, 200, researchSearchOutputSchema.parse(corpus.search(snapshotId, input)));
      }
      const input = readInput.parse(raw);
      const { snapshotId, ...rest } = input;
      return send(response, 200, researchReadOutputSchema.parse(corpus.read(snapshotId, rest)));
    } catch (error) {
      if (error instanceof z.ZodError || (error instanceof ResearchCorpusError && error.message === "invalid_request")) return send(response, 400, { errorCode: "invalid_request" });
      if (error instanceof ResearchCorpusError && error.message === "not_found") return send(response, 404, { errorCode: "not_found" });
      return send(response, 502, { errorCode: "research_failed" });
    }
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += (chunk as Buffer).byteLength;
    if (bytes > REQUEST_LIMIT) throw new Error("request_too_large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
