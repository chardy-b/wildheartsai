import {
  CHAT_MAX_CONTEXT_BYTES,
  CHAT_MAX_EVENT_BYTES,
  CHAT_MAX_REQUEST_BYTES,
  CHAT_MAX_TOOL_OUTPUT_BYTES,
  claimInputSchema,
  eventsInputSchema,
  finalizeInputSchema,
  CHAT_MAX_RESEARCH_OUTPUT_BYTES,
  RESEARCH_GATEWAY_HEADER,
  researchBeginInputSchema,
  researchErrorCodeSchema,
  researchOutputSchema,
  researchResultInputSchema,
  toolInputSchema,
  type ClaimInput,
  type ClaimReply,
  type FinalizeInput,
  type HeartbeatReply,
  type OperationAck,
  type ResearchBeginInput,
  type ResearchBeginReply,
  type ResearchOutput,
  type ResearchResultInput,
  type ToolReply,
} from "./protocol.js";
import type { ChatMessage, ClaimedWebRun, WorkerEvent } from "./contracts.js";

const grantPattern = /^whchat1\.(execution|control)\.[A-Za-z0-9_-]{43}$/;
const researchGatewayTokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const CHAT_MAX_TOOL_REPLY_BYTES = CHAT_MAX_TOOL_OUTPUT_BYTES + 1_024;

export class ChatWebApiError extends Error {
  constructor(readonly status: number, readonly code = "chat_web_api_unavailable", readonly retryAfterMs?: number) {
    super(code);
    this.name = "ChatWebApiError";
  }
}

export type ChatWebApiOptions = Readonly<{
  baseUrl: URL;
  coordinatorToken?: string;
  fetcher?: typeof fetch;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  requestTimeoutMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

/** Fixed-origin HTTP adapter. Credentials are selected by operation, never by request data. */
export class ChatWebApi {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly attempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly timeoutMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ChatWebApiOptions) {
    this.baseUrl = validateWebApiUrl(options.baseUrl);
    this.fetcher = options.fetcher ?? fetch;
    this.attempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
    this.retryBaseMs = Math.max(1, options.retryBaseMs ?? 100);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 1_000);
    this.timeoutMs = Math.max(100, options.requestTimeoutMs ?? 5_000);
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async claim(input: ClaimInput): Promise<Readonly<{ run: ClaimedWebRun | null }>> {
    const request = claimInputSchema.parse(input);
    const token = this.coordinatorToken();
    const body = await this.post("claims", token, request, CHAT_MAX_REQUEST_BYTES, "coordinator");
    if (!hasExactKeys(body, ["run"])) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    if (body.run === null) return { run: null };
    const run = parseClaimReply(body.run);
    return { run };
  }

  async heartbeat(controlGrant: string): Promise<HeartbeatReply> {
    const reply = await this.post("control/heartbeat", this.controlGrant(controlGrant), {}, CHAT_MAX_REQUEST_BYTES, "control");
    if (!hasExactKeys(reply, ["active", "cancelled", "deadlineAt"])) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    const value = reply as Record<string, unknown>;
    if (typeof value.active !== "boolean" || typeof value.cancelled !== "boolean" || !validDate(value.deadlineAt)) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    return { active: value.active, cancelled: value.cancelled, deadlineAt: value.deadlineAt };
  }

  async finalize(controlGrant: string, input: FinalizeInput): Promise<OperationAck> {
    const request = finalizeInputSchema.parse(input);
    return parseAck(await this.post("control/finalize", this.controlGrant(controlGrant), request, CHAT_MAX_REQUEST_BYTES, "control"));
  }

  async context(executionGrant: string): Promise<Readonly<{ messages: ReadonlyArray<ChatMessage>; modelId: string }>> {
    const reply = await this.request("execution/context", this.executionGrant(executionGrant), "GET", undefined, CHAT_MAX_CONTEXT_BYTES, "execution");
    if (!hasExactKeys(reply, ["messages", "modelId"])) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    const value = reply as Record<string, unknown>;
    if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 64 || typeof value.modelId !== "string" || value.modelId.length < 1 || value.modelId.length > 200) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    const messages = value.messages.map((message) => {
      if (!hasExactKeys(message, ["role", "content"])) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
      const item = message as Record<string, unknown>;
      if ((item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string") throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
      return { role: item.role, content: item.content } satisfies ChatMessage;
    });
    if (byteLength(JSON.stringify(messages)) > CHAT_MAX_CONTEXT_BYTES) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    return { messages, modelId: value.modelId };
  }

  async isCancelled(executionGrant: string): Promise<boolean> {
    const reply = await this.request("execution/cancellation", this.executionGrant(executionGrant), "GET", undefined, CHAT_MAX_REQUEST_BYTES, "execution");
    if (!hasExactKeys(reply, ["cancelled"]) || typeof (reply as Record<string, unknown>).cancelled !== "boolean") throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    return (reply as { cancelled: boolean }).cancelled;
  }

  async invokeTool(executionGrant: string, input: unknown): Promise<ToolReply> {
    const request = toolInputSchema.parse(input);
    const reply = await this.post("execution/tools", this.executionGrant(executionGrant), request, CHAT_MAX_REQUEST_BYTES, "execution");
    if (byteLength(JSON.stringify(reply)) > CHAT_MAX_TOOL_REPLY_BYTES) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    if (!hasExactKeys(reply, ["status", "output"])) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    const value = reply as Record<string, unknown>;
    if (value.status !== "completed" || !value.output || typeof value.output !== "object" || Array.isArray(value.output)) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    if (byteLength(JSON.stringify(value.output)) > CHAT_MAX_TOOL_OUTPUT_BYTES) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    return { status: "completed", output: value.output as Record<string, unknown> };
  }

  async researchBegin(executionGrant: string, gatewayToken: string, input: ResearchBeginInput): Promise<ResearchBeginReply> {
    const request = researchBeginInputSchema.parse(input);
    const reply = await this.researchPost("execution/research/begin", executionGrant, gatewayToken, request);
    if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    const value = reply as Record<string, unknown>;
    if (value.status === "execute" && hasExactKeys(reply, ["status", "operationId", "snapshotId", "deadlineAt"])) {
      if (!validUuid(value.operationId) || typeof value.snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshotId) || !validDate(value.deadlineAt)) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
      return { status: "execute", operationId: value.operationId, snapshotId: value.snapshotId, deadlineAt: value.deadlineAt };
    }
    if (value.status === "completed" && hasExactKeys(reply, ["status", "operationId", "output"])) {
      if (!validUuid(value.operationId)) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
      const output = parseResearchOutput(value.output);
      return { status: "completed", operationId: value.operationId, output };
    }
    if (value.status === "failed" && hasExactKeys(reply, ["status", "operationId", "errorCode"])) {
      const errorCode = researchErrorCodeSchema.safeParse(value.errorCode);
      if (!validUuid(value.operationId) || !errorCode.success) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
      return { status: "failed", operationId: value.operationId, errorCode: errorCode.data };
    }
    throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
  }

  async researchResult(executionGrant: string, gatewayToken: string, input: ResearchResultInput): Promise<OperationAck> {
    const request = researchResultInputSchema.parse(input);
    if (request.status === "completed" && byteLength(JSON.stringify(request.output)) > CHAT_MAX_RESEARCH_OUTPUT_BYTES) throw new ChatWebApiError(413, "chat_research_result_too_large");
    return parseAck(await this.researchPost("execution/research/result", executionGrant, gatewayToken, request));
  }

  async publishEvents(executionGrant: string, events: ReadonlyArray<WorkerEvent>): Promise<OperationAck> {
    const request = eventsInputSchema.parse({ events });
    return parseAck(await this.post("execution/events", this.executionGrant(executionGrant), request, CHAT_MAX_EVENT_BYTES, "execution"));
  }

  private post(path: string, token: string, value: unknown, maxBytes: number, kind: "coordinator" | "control" | "execution") {
    return this.request(path, token, "POST", value, maxBytes, kind);
  }

  private researchPost(path: "execution/research/begin" | "execution/research/result", executionGrant: string, gatewayToken: string, value: ResearchBeginInput | ResearchResultInput) {
    if (!researchGatewayTokenPattern.test(gatewayToken)) throw new ChatWebApiError(401, "invalid_research_gateway_token");
    return this.request(path, this.executionGrant(executionGrant), "POST", value, CHAT_MAX_REQUEST_BYTES, "execution", gatewayToken);
  }

  private async request(path: string, token: string, method: "GET" | "POST", value: unknown, maxBytes: number, kind: "coordinator" | "control" | "execution", researchGatewayToken?: string): Promise<unknown> {
    if (researchGatewayToken && (!path.startsWith("execution/research/") || !researchGatewayTokenPattern.test(researchGatewayToken))) throw new ChatWebApiError(401, "invalid_research_gateway_token");
    const body = value === undefined ? undefined : JSON.stringify(value);
    if (body !== undefined && byteLength(body) > maxBytes) throw new ChatWebApiError(413, "chat_web_api_request_too_large");
    const url = new URL(path, this.baseUrl);
    let lastStatus = 0;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(researchGatewayToken ? { [RESEARCH_GATEWAY_HEADER]: researchGatewayToken } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body }),
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt + 1 >= this.attempts) throw new ChatWebApiError(503);
        await this.delay(attempt);
        continue;
      }
      if (retryableStatus(response.status)) {
        lastStatus = response.status;
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        if (attempt + 1 >= this.attempts) throw new ChatWebApiError(response.status, response.status === 429 ? "chat_web_api_rate_limited" : "chat_web_api_unavailable", retryAfterMs);
        await response.body?.cancel().catch(() => undefined);
        await this.delay(attempt, retryAfterMs);
        continue;
      }
      if (!response.ok) throw new ChatWebApiError(response.status);
      const maxResponseBytes = path === "execution/context" ? CHAT_MAX_CONTEXT_BYTES : path === "execution/tools" ? CHAT_MAX_TOOL_REPLY_BYTES : path === "execution/events" ? CHAT_MAX_EVENT_BYTES : path.startsWith("execution/research/") ? CHAT_MAX_REQUEST_BYTES : CHAT_MAX_REQUEST_BYTES;
      return await readBoundedJson(response, maxResponseBytes);
    }
    throw new ChatWebApiError(lastStatus || 503);
  }

  private delay(attempt: number, retryAfterMs?: number): Promise<void> {
    const ceiling = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** attempt));
    const jitter = Math.max(0, Math.min(0.999_999, this.random()));
    return this.sleep(Math.max(Math.floor(ceiling * jitter), retryAfterMs ?? 0));
  }

  private coordinatorToken(): string {
    if (!this.options.coordinatorToken || this.options.coordinatorToken.length < 32) throw new ChatWebApiError(500, "chat_coordinator_not_configured");
    return this.options.coordinatorToken;
  }

  private controlGrant(token: string): string {
    if (!grantPattern.test(token) || !token.startsWith("whchat1.control.")) throw new ChatWebApiError(401, "invalid_control_grant");
    return token;
  }

  private executionGrant(token: string): string {
    if (!grantPattern.test(token) || !token.startsWith("whchat1.execution.")) throw new ChatWebApiError(401, "invalid_execution_grant");
    return token;
  }
}

export function validateWebApiUrl(input: URL): URL {
  const url = new URL(input.toString());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!/^https?:$/.test(url.protocol) || (url.protocol === "http:" && !loopback) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/api/chat/worker/v1") throw new Error("invalid_chat_web_api_url");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}

function parseResearchOutput(value: unknown): ResearchOutput {
  const parsed = researchOutputSchema.safeParse(value);
  if (!parsed.success || byteLength(JSON.stringify(parsed.data)) > CHAT_MAX_RESEARCH_OUTPUT_BYTES) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
  return parsed.data;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
    }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
  }
}

function parseClaimReply(value: unknown): ClaimedWebRun {
  if (!hasExactKeys(value, ["id", "attempt", "leaseOwner", "deadlineAt", "leaseExpiresAt", "executionGrant", "controlGrant"])) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
  const run = value as ClaimReply & Record<string, unknown>;
  if (typeof run.id !== "string" || !/^[0-9a-f-]{36}$/i.test(run.id) || !Number.isSafeInteger(run.attempt) || run.attempt < 1 || typeof run.leaseOwner !== "string" || !validDate(run.deadlineAt) || !validDate(run.leaseExpiresAt) || typeof run.executionGrant !== "string" || !grantPattern.test(run.executionGrant) || !run.executionGrant.startsWith("whchat1.execution.") || typeof run.controlGrant !== "string" || !grantPattern.test(run.controlGrant) || !run.controlGrant.startsWith("whchat1.control.")) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
  return { id: run.id, attempt: run.attempt, leaseOwner: run.leaseOwner, deadlineAt: run.deadlineAt, leaseExpiresAt: run.leaseExpiresAt, executionGrant: run.executionGrant, controlGrant: run.controlGrant };
}

function parseAck(value: unknown): OperationAck {
  if (!hasExactKeys(value, ["status"])) throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
  const status = (value as Record<string, unknown>).status;
  if (status !== "accepted" && status !== "duplicate") throw new ChatWebApiError(502, "chat_web_api_invalid_reply");
  return { status };
}

function validDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function retryableStatus(status: number): boolean { return status === 408 || status === 429 || status >= 500; }
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.min(30_000, Math.ceil(milliseconds)) : undefined;
}
function hasExactKeys(value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
