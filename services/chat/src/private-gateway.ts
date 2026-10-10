import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { CHAT_MAX_CONTEXT_BYTES, CHAT_MAX_EVENT_BYTES, CHAT_MAX_REQUEST_BYTES, CHAT_MAX_RESEARCH_OUTPUT_BYTES, CHAT_MAX_TOOL_OUTPUT_BYTES, agentToolInputSchema, protocolEventSchema, researchErrorCodeSchema, researchOutputSchema } from "./protocol.js";
import { CHAT_MAX_TOOL_REPLY_BYTES, ChatWebApi, ChatWebApiError } from "./web-api.js";
import type { ChatMessage, ToolName, WorkerEvent } from "./contracts.js";
import type { ResearchBeginReply, ResearchErrorCode, ResearchOutput } from "./protocol.js";

const executionGrantPattern = /^whchat1\.execution\.[A-Za-z0-9_-]{43}$/;
const inferenceRequestLimit = 512 * 1024;
const inferenceStreamLimit = 4 * 1024 * 1024;
const inferenceTimeoutMs = 120_000;
const defaultInferenceAttemptTimeoutMs = 45_000;
const inferenceCancellationPollMs = 2_000;
const retryableInferenceStatuses = new Set([404, 408, 429, 500, 502, 503, 504]);

export type PrivateGatewayOptions = Readonly<{
  api: ChatWebApi;
  inferenceUrl: URL;
  modelId: string;
  fallbackModelIds?: readonly string[];
  attemptTimeoutMs?: number;
  maxTokens: number;
  apiKey?: string;
  researchCorpus?: OfflineResearchCorpus;
  researchGatewayToken?: string;
  fetcher?: typeof fetch;
}>;

export type OfflineResearchCorpus = Readonly<{
  captureSnapshot(): Promise<Readonly<{ snapshotId: string }>>;
  search(snapshotId: unknown, input: unknown): unknown;
  read(snapshotId: unknown, input: unknown): unknown;
}>;

/** Private worker relay: execution grants authorize only web-owned run operations. */
export function createPrivateToolGateway(options: PrivateGatewayOptions) {
  const inferenceUrl = validateInferenceUrl(options.inferenceUrl);
  const inferenceModels = validateInferenceModels(options.modelId, options.fallbackModelIds ?? []);
  const attemptTimeoutMs = options.attemptTimeoutMs ?? (inferenceModels.length > 1 ? defaultInferenceAttemptTimeoutMs : inferenceTimeoutMs);
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > inferenceTimeoutMs) throw new Error("invalid_chat_inference_attempt_timeout");
  const fetcher = options.fetcher ?? fetch;
  const loadedSnapshots = new Map<string, true>();
  const runSnapshots = new Map<string, string>();
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
      const body = agentToolInputSchema.parse(await readJsonBody(request, CHAT_MAX_REQUEST_BYTES));
      const result = body.tool === "search_research" || body.tool === "read_research"
        ? await invokeResearch(executionGrant, body)
        : await options.api.invokeTool(executionGrant, body);
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
    const controller = new AbortController();
    const stop = () => controller.abort();
    request.once("aborted", stop);
    response.once("close", stop);
    const deadlineAt = Date.now() + inferenceTimeoutMs;
    const deadline = setTimeout(stop, inferenceTimeoutMs);
    let polling = false;
    let cancellationPoll: ReturnType<typeof setInterval> | undefined;
    const requestedTokens = typeof body.max_tokens === "number" && Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : options.maxTokens;
    const inferenceBody = {
      messages: body.messages,
      ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
      ...(body.tool_choice === undefined ? {} : { tool_choice: body.tool_choice }),
      stream: body.stream === true,
      ...(body.stream_options && typeof body.stream_options === "object" ? { stream_options: body.stream_options } : {}),
      max_tokens: Math.min(requestedTokens, options.maxTokens),
      ...(typeof body.temperature === "number" && Number.isFinite(body.temperature) ? { temperature: Math.max(0, Math.min(1, body.temperature)) } : {}),
    };
    try {
      const initiallyCancelled = await raceWithDeadline(options.api.isCancelled(executionGrant), controller.signal, deadlineAt - Date.now());
      if (controller.signal.aborted) return sendJson(response, 502, { error: "inference_unavailable" });
      if (initiallyCancelled) return sendJson(response, 409, { error: "run_not_active" });
      cancellationPoll = setInterval(() => {
        if (polling || controller.signal.aborted) return;
        polling = true;
        void options.api.isCancelled(executionGrant).then((cancelled) => { if (cancelled) stop(); }).catch(stop).finally(() => { polling = false; });
      }, inferenceCancellationPollMs);

      const url = new URL("chat/completions", inferenceUrl);
      for (let index = 0; index < inferenceModels.length; index += 1) {
        if (controller.signal.aborted || Date.now() >= deadlineAt) break;
        if (index > 0 && !await mayStartFallback(options.api, executionGrant, controller.signal, deadlineAt, stop)) break;
        if (controller.signal.aborted || Date.now() >= deadlineAt) break;

        const modelId = inferenceModels[index]!;
        const attemptController = new AbortController();
        const abortAttempt = () => attemptController.abort();
        controller.signal.addEventListener("abort", abortAttempt, { once: true });
        let attemptTimedOut = false;
        const remainingMs = Math.max(1, deadlineAt - Date.now());
        const attemptBudgetMs = Math.min(attemptTimeoutMs, remainingMs);
        const attemptTimer = setTimeout(() => { attemptTimedOut = true; attemptController.abort(); }, attemptBudgetMs);
        let upstream: Response | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let firstByteForwarded = false;
        let retryableFailure = false;
        try {
          if (controller.signal.aborted || Date.now() >= deadlineAt) break;
          upstream = await fetcher(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
            body: JSON.stringify({ ...inferenceBody, model: modelId }),
            redirect: "error",
            signal: attemptController.signal,
          });
          if (controller.signal.aborted) break;
          if (upstream.redirected) {
            break;
          }
          if (!upstream.ok) {
            retryableFailure = retryableInferenceStatuses.has(upstream.status);
            if (retryableFailure && index + 1 < inferenceModels.length) continue;
            break;
          }
          if (!upstream.body) {
            retryableFailure = true;
            if (index + 1 < inferenceModels.length) continue;
            break;
          }

          reader = upstream.body.getReader();
          let first: Awaited<ReturnType<typeof reader.read>>;
          do { first = await reader.read(); } while (!first.done && first.value.byteLength === 0);
          if (controller.signal.aborted) break;
          if (attemptTimedOut) {
            retryableFailure = true;
            if (index + 1 < inferenceModels.length) continue;
            break;
          }
          if (first.done) {
            retryableFailure = true;
            if (index + 1 < inferenceModels.length) continue;
            break;
          }

          clearTimeout(attemptTimer);
          const firstChunk = first.value;
          if (firstChunk.byteLength > inferenceStreamLimit) break;
          response.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "x-wh-chat-model": modelId,
          });
          response.write(Buffer.from(firstChunk));
          firstByteForwarded = true;
          let bytes = firstChunk.byteLength;
          while (true) {
            const { done, value } = await reader.read();
            if (done || controller.signal.aborted) break;
            bytes += value.byteLength;
            if (bytes > inferenceStreamLimit) { await reader.cancel().catch(() => undefined); controller.abort(); break; }
            response.write(Buffer.from(value));
          }
          break;
        } catch (error) {
          if (!firstByteForwarded && !response.headersSent && !controller.signal.aborted) {
            retryableFailure = attemptTimedOut || isRetryableConnectionError(error);
          }
          if (firstByteForwarded) await reader?.cancel().catch(() => undefined);
          if (!retryableFailure || index + 1 >= inferenceModels.length || controller.signal.aborted) break;
          continue;
        } finally {
          clearTimeout(attemptTimer);
          controller.signal.removeEventListener("abort", abortAttempt);
          if (!firstByteForwarded) {
            if (reader) {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            } else {
              await upstream?.body?.cancel().catch(() => undefined);
            }
          } else {
            reader?.releaseLock();
          }
          if (attemptTimedOut || retryableFailure) attemptController.abort();
        }
      }
      if (!response.headersSent) sendJson(response, 502, { error: "inference_unavailable" });
      else if (!response.writableEnded) response.end();
    } catch {
      if (!response.headersSent) sendJson(response, 502, { error: "inference_unavailable" });
      else response.end();
    } finally {
      clearTimeout(deadline);
      if (cancellationPoll) clearInterval(cancellationPoll);
      request.off("aborted", stop);
      response.off("close", stop);
    }
  }

  async function invokeResearch(executionGrant: string, body: Extract<ReturnType<typeof agentToolInputSchema.parse>, { tool: "search_research" | "read_research" }>): Promise<ResearchWorkerReply> {
    const corpus = options.researchCorpus;
    const gatewayToken = options.researchGatewayToken;
    await requireActive(executionGrant);
    if (!corpus || !gatewayToken) return { status: "failed", errorCode: "research_unavailable" };

    let proposedSnapshotId: string | null = null;
    let captureFailed = false;
    if (body.tool === "search_research") {
      // Loading and hashing the bounded whole snapshot is not a query. Query-specific
      // search remains behind the web authority's begin operation below.
      try {
        const current = await corpus.captureSnapshot();
        rememberSnapshot(current.snapshotId);
        proposedSnapshotId = current.snapshotId;
      } catch {
        const pinnedInThisGateway = runSnapshots.get(executionGrant);
        if (pinnedInThisGateway) proposedSnapshotId = pinnedInThisGateway;
        else captureFailed = true;
      }
    } else {
      proposedSnapshotId = body.input.snapshotId;
      // Best-effort capture helps distinguish an unknown source in the current
      // snapshot from a pinned snapshot absent after a gateway restart. It never
      // changes the read's requested/pinned snapshot.
      try { rememberSnapshot((await corpus.captureSnapshot()).snapshotId); } catch { /* use only retained immutable snapshots */ }
    }

    // A null proposal lets the web authority either durably fail a new unavailable
    // search or execute against this run's already-persisted snapshot pin. The
    // returned snapshotId is authoritative in both cases.
    let beginInput: Parameters<ChatWebApi["researchBegin"]>[2];
    if (captureFailed) {
      if (body.tool !== "search_research") throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
      beginInput = { ...body, proposedSnapshotId: null, failureCode: "research_unavailable" };
    } else {
      if (!proposedSnapshotId) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
      beginInput = { ...body, proposedSnapshotId };
    }
    const begin = await options.api.researchBegin(executionGrant, gatewayToken, beginInput);
    if (begin.status === "completed") {
      await requireActive(executionGrant);
      return { status: "completed", output: begin.output };
    }
    if (begin.status === "failed") {
      if (proposedSnapshotId) rememberRunSnapshot(executionGrant, proposedSnapshotId);
      await requireActive(executionGrant);
      return { status: "failed", errorCode: begin.errorCode };
    }

    rememberRunSnapshot(executionGrant, begin.snapshotId);

    if (begin.snapshotId !== (body.tool === "read_research" ? body.input.snapshotId : begin.snapshotId)) {
      return persistFailure(begin, executionGrant, gatewayToken, "snapshot_unavailable");
    }

    let output: ResearchOutput;
    try {
      const rawOutput = body.tool === "search_research"
        ? corpus.search(begin.snapshotId, body.input)
        : corpus.read(begin.snapshotId, body.input);
      output = researchOutputSchema.parse(rawOutput);
      if (output.snapshotId !== begin.snapshotId) throw new Error("snapshot_mismatch");
      if (body.tool === "search_research" ? !isResearchSearchOutput(output) : !isResearchReadOutput(output)) throw new Error("output_shape_mismatch");
      if (Buffer.byteLength(JSON.stringify(output), "utf8") > CHAT_MAX_RESEARCH_OUTPUT_BYTES) {
        return persistFailure(begin, executionGrant, gatewayToken, "result_too_large");
      }
    } catch (error) {
      const code = researchErrorCode(error, body.tool === "read_research" && loadedSnapshots.has(begin.snapshotId));
      return persistFailure(begin, executionGrant, gatewayToken, code);
    }

    // Persistence is deliberately outside the lookup catch: an uncertain web write
    // must never be mistaken for a completed result or followed by an output reply.
    await options.api.researchResult(executionGrant, gatewayToken, { operationId: begin.operationId, status: "completed", output });
    await requireActive(executionGrant);
    return { status: "completed", output };
  }

  function rememberSnapshot(snapshotId: string): void {
    loadedSnapshots.delete(snapshotId);
    loadedSnapshots.set(snapshotId, true);
    while (loadedSnapshots.size > 2) loadedSnapshots.delete(loadedSnapshots.keys().next().value as string);
  }

  function rememberRunSnapshot(executionGrant: string, snapshotId: string): void {
    if (!snapshotId) return;
    runSnapshots.delete(executionGrant);
    runSnapshots.set(executionGrant, snapshotId);
    while (runSnapshots.size > 1_000) runSnapshots.delete(runSnapshots.keys().next().value as string);
  }

  async function persistFailure(begin: Extract<ResearchBeginReply, { status: "execute" }>, executionGrant: string, gatewayToken: string, errorCode: ResearchErrorCode): Promise<ResearchWorkerReply> {
    const code = researchErrorCodeSchema.parse(errorCode);
    await options.api.researchResult(executionGrant, gatewayToken, { operationId: begin.operationId, status: "failed", errorCode: code });
    await requireActive(executionGrant);
    return { status: "failed", errorCode: code };
  }

  async function requireActive(executionGrant: string): Promise<void> {
    if (await options.api.isCancelled(executionGrant)) throw new ChatWebApiError(409, "run_not_active");
  }
}

export type ResearchWorkerReply = { status: "completed"; output: ResearchOutput } | { status: "failed"; errorCode: ResearchErrorCode };

function isResearchSearchOutput(output: ResearchOutput): output is Extract<ResearchOutput, { hits: unknown }> { return "hits" in output; }
function isResearchReadOutput(output: ResearchOutput): output is Extract<ResearchOutput, { sourceId: unknown }> { return "sourceId" in output; }

function researchErrorCode(error: unknown, snapshotKnown: boolean): ResearchErrorCode {
  if (error instanceof ChatWebApiError) return "research_failed";
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    switch (error.code) {
      // The web authority has already issued this operation against a specific
      // snapshot pin. If that immutable snapshot is absent after restart (or
      // unreadable), fail this call closed instead of implying a current snapshot.
      case "unavailable": case "invalid_snapshot": return "snapshot_unavailable";
      case "not_found": return snapshotKnown ? "source_not_found" : "snapshot_unavailable";
      case "invalid_request": return "research_failed";
    }
  }
  return "research_failed";
}

function validateInferenceUrl(input: URL): URL {
  const url = new URL(input.toString());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid_chat_inference_url");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}

function validateInferenceModels(primary: string, fallbacks: readonly string[]): readonly string[] {
  const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
  if (!modelPattern.test(primary) || fallbacks.length > 3 || fallbacks.some((model) => !modelPattern.test(model))) throw new Error("invalid_chat_inference_models");
  const models = [primary, ...fallbacks];
  if (new Set(models).size !== models.length) throw new Error("invalid_chat_inference_models");
  return models;
}

async function raceWithDeadline<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (signal.aborted || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("chat_inference_deadline");
  return new Promise<T>((resolve, reject) => {
    const finish = (callback: (value: never) => void, value: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback(value as never);
    };
    const timer = setTimeout(() => finish(reject, new Error("chat_inference_deadline")), timeoutMs);
    const onAbort = () => finish(reject, new Error("chat_inference_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => finish(resolve as (value: never) => void, value), (error: unknown) => finish(reject, error));
  });
}

function isRetryableConnectionError(error: unknown): boolean {
  const retryableCodes = new Set([
    "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED",
  ]);
  let current: unknown = error;
  let message = "";
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const item = current as { code?: unknown; cause?: unknown; message?: unknown };
    if (typeof item.message === "string" && item.message.toLowerCase().includes("redirect")) return false;
    if (typeof item.code === "string") {
      if (item.code === "UND_ERR_REDIRECT") return false;
      if (retryableCodes.has(item.code)) return true;
    }
    if (depth === 0 && typeof item.message === "string") message = item.message.toLowerCase();
    current = item.cause;
  }
  return error instanceof TypeError && (message === "fetch failed" || message === "terminated");
}

async function mayStartFallback(api: ChatWebApi, executionGrant: string, signal: AbortSignal, deadlineAt: number, abortOverall: () => void): Promise<boolean> {
  if (signal.aborted || Date.now() >= deadlineAt) return false;
  try {
    const remainingMs = deadlineAt - Date.now();
    const cancelled = await raceWithDeadline(api.isCancelled(executionGrant), signal, remainingMs);
    if (signal.aborted || Date.now() >= deadlineAt) return false;
    if (cancelled) { abortOverall(); return false; }
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const onBodyTimeout = () => request.destroy();
  request.setTimeout(5_000, onBodyTimeout);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > maxBytes) throw new ChatWebApiError(413, "worker_request_too_large");
      chunks.push(value);
    }
  } finally {
    request.setTimeout(0);
    request.off("timeout", onBodyTimeout);
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
    const request = agentToolInputSchema.parse({ toolCallId, tool, input });
    const response = await this.post("/v1/tools", request, signal);
    if (!response.ok) throw new Error("tool_gateway_rejected");
    const raw = await readBoundedResponse(response, CHAT_MAX_TOOL_REPLY_BYTES);
    const replySchema = z.union([
      z.object({ status: z.literal("completed"), output: z.record(z.string(), z.unknown()) }).strict(),
      z.object({ status: z.literal("failed"), errorCode: researchErrorCodeSchema }).strict(),
    ]);
    const parsed = replySchema.safeParse(raw);
    if (!parsed.success) throw new Error("tool_gateway_rejected");
    if (parsed.data.status === "failed") {
      if (tool !== "search_research" && tool !== "read_research") throw new Error("tool_gateway_rejected");
      return parsed.data;
    }
    if (Buffer.byteLength(JSON.stringify(parsed.data.output), "utf8") > CHAT_MAX_TOOL_OUTPUT_BYTES) throw new Error("tool_gateway_rejected");
    if (tool === "search_research" || tool === "read_research") {
      const output = researchOutputSchema.safeParse(parsed.data.output);
      if (!output.success || Buffer.byteLength(JSON.stringify(output.data), "utf8") > CHAT_MAX_RESEARCH_OUTPUT_BYTES) throw new Error("tool_gateway_rejected");
      if (tool === "search_research" ? !isResearchSearchOutput(output.data) : !isResearchReadOutput(output.data)) throw new Error("tool_gateway_rejected");
    }
    return parsed.data;
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

async function readBoundedResponse(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("tool_gateway_rejected");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("tool_gateway_rejected");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("tool_gateway_rejected"); }
}
