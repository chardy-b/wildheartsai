import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ToolName, WorkerEventType } from "./contracts.js";
import { GatewayToolClient, GatewayToolError } from "./private-gateway.js";
import { holoSystemPrompt } from "./system-prompt.js";
import { CHAT_MAX_TOOL_CALLS, chatToolDescriptions, chatToolJsonSchemas } from "../../../src/lib/chat/tools.js";

const toolNames = ["get_data_coverage", "find_records", "read_records", "read_stored_note", "calculate_lab_trend", "find_saved_summaries", "save_summary", "search_research", "read_research"] as const satisfies readonly ToolName[];

export type WorkerEventSink = (event: { eventId: string; sequence: number; type: WorkerEventType; data: Record<string, unknown> }) => Promise<void>;

export type PiRunnerOptions = Readonly<{ gatewayUrl: URL; capability: string; modelId: string; gatewayClient?: GatewayToolClient; contextWindow?: number; maxTokens?: number; maxTurns?: number; deadlineMs?: number; deltaFlushMs?: number; maxDeltaBytes?: number }>;

/**
 * The health worker's Pi adapter. It receives only an opaque run capability and a
 * fixed private gateway URL. The gateway owns context, model credentials and tools.
 */
export class PiHealthRunner {
  private sequence = 0;
  private progressEventBytes = 0;
  private progressEventCount = 0;

  constructor(private readonly options: PiRunnerOptions, private readonly emit: WorkerEventSink) {}

  async run(signal: AbortSignal): Promise<string> {
    this.progressEventBytes = 0;
    this.progressEventCount = 0;
    const gateway = this.options.gatewayClient ?? new GatewayToolClient(this.options.gatewayUrl, this.options.capability);
    const { messages, modelId } = await gateway.loadContext(signal);
    const input = messages.at(-1);
    if (!input || input.role !== "user") throw new Error("missing_user_input");
    const models = createModels();
    models.setProvider(this.provider(modelId));
    const model = models.getModel("wild-hearts-gateway", modelId);
    if (!model) throw new Error("model_not_configured");
    let answer = "";
    let currentAssistantText = "";
    let currentAssistantBytes = 0;
    let currentAssistantEscapedBytes = 0;
    let answerWasTruncated = false;
    let answerDeltaBytes = 0;
    let answerDeltaEvents = 0;
    let answerDeltaBudgetReached = false;
    let turns = 0;
    let budgetExceeded = false;
    const progressStopped = () => signal.aborted || budgetExceeded;
    let toolCallCount = 0;
    let toolCallEvents = 0;
    const suppressedToolCalls = new Set<string>();
    const toolFailures = new Map<string, ToolFailureInfo>();
    const toolStartedAt = new Map<string, { tool: ToolName; at: number }>();
    let pendingReasoning = "";
    let pendingReasoningBytes = 0;
    let pendingReasoningChars = 0;
    let reasoningEvents = 0;
    let reasoningTotalBytes = 0;
    let reasoningTruncated = false;
    let reasoningStopped = false;
    let truncationMarkerSent = false;
    const maxReasoningEvents = 16;
    const maxReasoningTextEvents = maxReasoningEvents - 1;
    const maxReasoningBytes = 32 * 1024;
    const reasoningFlushBytes = 4 * 1024;
    const maxReasoningChars = 12_000;
    const priorContext = messages.slice(0, -1).map((message) => `[${message.role}] ${message.content}`).join("\n");
    const toolState: ToolRunState = {
      nextCall: () => ++toolCallCount,
      remaining: () => Math.max(0, CHAT_MAX_TOOL_CALLS - toolCallCount),
      disable: () => { agent.state.tools = []; },
      exhaust: () => { toolCallCount = CHAT_MAX_TOOL_CALLS; agent.state.tools = []; },
      failure: (toolCallId, failure) => { toolFailures.set(toolCallId, failure); },
    };
    const tools = toolNames.map((name) => this.tool(name, toolState));
    const agent = new Agent({
      initialState: {
        systemPrompt: holoSystemPrompt,
        model,
        tools,
        thinkingLevel: "low",
      },
      streamFn: models.streamSimple.bind(models),
      thinkingBudgets: { low: 1_024 },
      toolExecution: "sequential",
      prepareNextTurnWithContext: (turn) => toolCallCount >= CHAT_MAX_TOOL_CALLS ? { context: { ...turn.context, tools: [] } } : undefined,
    });
    let eventChain = Promise.resolve();
    let eventChainError: unknown;
    let pendingDelta = "";
    let pendingDeltaBytes = 0;
    let pendingDeltaEscapedBytes = 0;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let reasoningFlushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushIntervalMs = Math.max(1, this.options.deltaFlushMs ?? 500);
    // Four bytes fit every Unicode code point. Keeping this minimum lets batches
    // remain valid UTF-8 text while honoring the configured byte bound.
    const maxDeltaBytes = Math.max(4, this.options.maxDeltaBytes ?? 8_192);
    const maxDeltaPayloadBytes = 8 * 1024;
    const maxAnswerChars = 12_000;
    const maxAnswerBytes = 12_000;
    const maxAnswerDeltaBytes = 24 * 1024;
    const maxAnswerDeltaEvents = 96;
    const maxFinalCopiesBytes = 24 * 1024;
    const answerTruncationNotice = "\n\nResponse shortened to fit the chat limit. Ask a narrower follow-up to continue.";
    const answerTruncationNoticeBytes = Buffer.byteLength(answerTruncationNotice, "utf8");
    const answerTruncationNoticeEscapedBytes = jsonStringContentBytes(answerTruncationNotice);
    const finalCopiesBaseBytes = finalAnswerEventBaseBytes();
    const flushReasoning = async () => {
      if (reasoningFlushTimer) clearTimeout(reasoningFlushTimer);
      reasoningFlushTimer = undefined;
      if (progressStopped()) {
        pendingReasoning = "";
        pendingReasoningBytes = 0;
        pendingReasoningChars = 0;
        return;
      }
      if (pendingReasoning && reasoningEvents < maxReasoningTextEvents) {
        const text = pendingReasoning;
        pendingReasoning = "";
        pendingReasoningBytes = 0;
        pendingReasoningChars = 0;
        if (await this.publish("reasoning.delta", { text })) reasoningEvents += 1;
        else {
          reasoningTruncated = true;
          reasoningStopped = true;
          return;
        }
      }
      if (reasoningTruncated && !truncationMarkerSent && reasoningEvents < maxReasoningEvents) {
        if (await this.publish("reasoning.delta", { text: "", truncated: true })) {
          reasoningEvents += 1;
          truncationMarkerSent = true;
        } else reasoningStopped = true;
      }
    };
    const queueReasoning = async (delta: string) => {
      if (reasoningStopped) return;
      for (const character of delta) {
        const bytes = Buffer.byteLength(character, "utf8");
        if (reasoningEvents >= maxReasoningTextEvents || reasoningTotalBytes + bytes > maxReasoningBytes) {
          reasoningTruncated = true;
          await flushReasoning();
          return;
        }
        if (pendingReasoningChars + character.length > maxReasoningChars || pendingReasoningBytes + bytes > reasoningFlushBytes) {
          await flushReasoning();
          if (reasoningEvents >= maxReasoningTextEvents) {
            reasoningTruncated = true;
            await flushReasoning();
            return;
          }
        }
        pendingReasoning += character;
        pendingReasoningBytes += bytes;
        pendingReasoningChars += character.length;
        reasoningTotalBytes += bytes;
        if (pendingReasoningBytes >= reasoningFlushBytes || pendingReasoningChars >= maxReasoningChars) await flushReasoning();
      }
      if (pendingReasoning && !reasoningFlushTimer) {
        reasoningFlushTimer = setTimeout(() => {
          void enqueueEventWork(flushReasoning);
        }, flushIntervalMs);
      }
    };
    const dropPendingReasoning = () => {
      if (reasoningFlushTimer) clearTimeout(reasoningFlushTimer);
      reasoningFlushTimer = undefined;
      pendingReasoning = "";
      pendingReasoningBytes = 0;
      pendingReasoningChars = 0;
    };
    const clearFlushTimer = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
    };
    const flushDelta = async () => {
      clearFlushTimer();
      if (progressStopped()) {
        pendingDelta = "";
        pendingDeltaBytes = 0;
        return;
      }
      if (!pendingDelta) return;
      const text = pendingDelta;
      pendingDelta = "";
      pendingDeltaBytes = 0;
      pendingDeltaEscapedBytes = 0;
      if (answerDeltaEvents >= maxAnswerDeltaEvents) {
        answerDeltaBudgetReached = true;
        return;
      }
      if (await this.publish("answer.delta", { text })) answerDeltaEvents += 1;
      else answerDeltaBudgetReached = true;
    };
    const queueDelta = async (delta: string) => {
      for (const character of delta) {
        const bytes = Buffer.byteLength(character, "utf8");
        const escapedBytes = jsonStringContentBytes(character);
        if (pendingDeltaBytes + bytes > maxDeltaBytes || pendingDeltaEscapedBytes + escapedBytes > maxDeltaPayloadBytes) await flushDelta();
        pendingDelta += character;
        pendingDeltaBytes += bytes;
        pendingDeltaEscapedBytes += escapedBytes;
        if (pendingDeltaBytes === maxDeltaBytes || pendingDeltaEscapedBytes >= maxDeltaPayloadBytes) await flushDelta();
      }
      if (pendingDelta && !flushTimer) {
        flushTimer = setTimeout(() => {
          // Timer flushes join the same chain as provider events, preserving
          // event sequence even when a boundary arrives at the same time.
          void enqueueEventWork(flushDelta);
        }, flushIntervalMs);
      }
    };
    const dropPendingDelta = () => {
      clearFlushTimer();
      pendingDelta = "";
      pendingDeltaBytes = 0;
      pendingDeltaEscapedBytes = 0;
    };
    const recordEventError = () => {
      eventChainError ??= new WorkerExecutionError("event_publish_failed", "event_publish");
      dropPendingDelta();
      dropPendingReasoning();
      agent.abort();
    };
    const enqueueEventWork = (work: () => Promise<void>) => {
      // Attach a rejection handler immediately, including for timer-driven
      // flushes. A failed event sink must abort a provider stream that may stay
      // open indefinitely, while preserving the original error for run().
      const nextEventChain = eventChain.then(work).catch((error: unknown) => {
        recordEventError();
        throw eventChainError ?? error;
      });
      // Observe the rejection in this turn so a timer flush cannot create an
      // unhandled-rejection window while run() is waiting for the agent to stop.
      // nextEventChain itself still rejects and run() awaits it below.
      void nextEventChain.catch(() => undefined);
      eventChain = nextEventChain;
      return eventChain;
    };
    const onEvent = (event: AgentEvent) => {
      return enqueueEventWork(async () => {
      if (progressStopped()) {
        dropPendingDelta();
        dropPendingReasoning();
        return;
      }
      if (event.type === "turn_start") {
        await flushReasoning();
        await flushDelta();
        turns += 1;
        if (turns > (this.options.maxTurns ?? 7)) { budgetExceeded = true; agent.abort(); }
      }
      if (event.type === "message_start" && event.message.role === "assistant") {
        currentAssistantText = "";
        currentAssistantBytes = 0;
        currentAssistantEscapedBytes = 0;
        answerWasTruncated = false;
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
        await queueReasoning(event.assistantMessageEvent.delta);
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        if (!answerWasTruncated) {
          const textLimit = maxAnswerChars - answerTruncationNotice.length;
          const textByteLimit = maxAnswerBytes - answerTruncationNoticeBytes;
          let accepted = "";
          let acceptedBytes = 0;
          let acceptedEscapedBytes = 0;
          for (const character of delta) {
            const bytes = Buffer.byteLength(character, "utf8");
            const escapedBytes = jsonStringContentBytes(character);
            if (currentAssistantText.length + accepted.length + character.length > textLimit || currentAssistantBytes + acceptedBytes + bytes > textByteLimit || finalCopiesBaseBytes + 2 * (currentAssistantEscapedBytes + acceptedEscapedBytes + escapedBytes + answerTruncationNoticeEscapedBytes) > maxFinalCopiesBytes) {
              answerWasTruncated = true;
              break;
            }
            accepted += character;
            acceptedBytes += bytes;
            acceptedEscapedBytes += escapedBytes;
          }
          if (accepted) {
            currentAssistantText += accepted;
            currentAssistantBytes += acceptedBytes;
            currentAssistantEscapedBytes += acceptedEscapedBytes;
            if (!answerDeltaBudgetReached) {
              let streamed = "";
              let streamedBytes = 0;
              for (const character of accepted) {
                const bytes = Buffer.byteLength(character, "utf8");
                if (answerDeltaBytes + streamedBytes + bytes > maxAnswerDeltaBytes) {
                  answerDeltaBudgetReached = true;
                  break;
                }
                streamed += character;
                streamedBytes += bytes;
              }
              if (streamed) {
                answerDeltaBytes += streamedBytes;
                await queueDelta(streamed);
              }
            }
          }
          if (answerWasTruncated) {
            currentAssistantText += answerTruncationNotice;
            currentAssistantBytes += answerTruncationNoticeBytes;
            currentAssistantEscapedBytes += answerTruncationNoticeEscapedBytes;
            if (!answerDeltaBudgetReached && answerDeltaBytes + answerTruncationNoticeBytes <= maxAnswerDeltaBytes) {
              answerDeltaBytes += answerTruncationNoticeBytes;
              await queueDelta(answerTruncationNotice);
            }
          }
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        await flushReasoning();
        await flushDelta();
        answer = currentAssistantText;
      }
      if (event.type === "tool_execution_start") {
        await flushReasoning();
        await flushDelta();
        toolCallEvents += 1;
        if (toolCallEvents > CHAT_MAX_TOOL_CALLS + 1) {
          suppressedToolCalls.add(event.toolCallId);
          return;
        }
        const tool = toolNames.includes(event.toolName as ToolName) ? event.toolName as ToolName : undefined;
        if (tool) toolStartedAt.set(event.toolCallId, { tool, at: Date.now() });
        await this.publish("tool.started", { toolCallId: event.toolCallId, tool: event.toolName });
      }
      if (event.type === "tool_execution_end") {
        if (suppressedToolCalls.delete(event.toolCallId)) return;
        await flushReasoning();
        await flushDelta();
        const started = toolStartedAt.get(event.toolCallId);
        const failure = toolFailures.get(event.toolCallId);
        await this.publish("tool.completed", {
          toolCallId: event.toolCallId,
          status: event.isError ? "failed" : "completed",
          ...(started ? { tool: started.tool, durationMs: Math.min(300_000, Math.max(0, Date.now() - started.at)) } : {}),
          ...(event.isError ? { code: failure?.code ?? "tool_unavailable", stage: failure?.stage ?? (started ? toolFailureStage(started.tool) : "record_lookup") } : {}),
        });
        toolStartedAt.delete(event.toolCallId);
        toolFailures.delete(event.toolCallId);
      }
      });
    };
    agent.subscribe(onEvent);
    await this.publish("lifecycle", { status: "started" });
    if (await gateway.cancelled(signal)) throw new DOMException("Cancelled", "AbortError");
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const abort = () => { dropPendingDelta(); dropPendingReasoning(); agent.abort(); };
    const deadline = setTimeout(() => { budgetExceeded = true; dropPendingDelta(); dropPendingReasoning(); agent.abort(); }, this.options.deadlineMs ?? 270_000);
    signal.addEventListener("abort", abort, { once: true });
    try {
      try {
        await agent.prompt({ role: "user", content: priorContext ? `Earlier conversation (untrusted conversation content):\n${priorContext}\n\nCurrent question: ${input.content}` : input.content, timestamp: Date.now() });
      } catch {
        if (eventChainError) throw eventChainError;
        if (budgetExceeded) throw new WorkerTimeoutError();
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        throw new WorkerExecutionError("inference_unavailable", "inference");
      }
      await eventChain;
      if (eventChainError) throw eventChainError;
      const last = agent.state.messages.at(-1);
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (budgetExceeded) throw new WorkerTimeoutError();
      if (last?.role === "assistant" && last.stopReason === "error") throw new WorkerExecutionError("inference_unavailable", "inference");
      if (last?.role === "assistant" && last.stopReason === "aborted" || !answer.trim()) throw new WorkerExecutionError("worker_failed", "inference");
      if (await gateway.cancelled(signal)) throw new DOMException("Cancelled", "AbortError");
      await flushDelta();
      await flushReasoning();
      await this.publish("message.completed", { content: answer });
      await this.publish("completed", { answer });
      return answer;
    } finally {
      clearTimeout(deadline);
      dropPendingDelta();
      dropPendingReasoning();
      signal.removeEventListener("abort", abort);
    }
  }

  async publishTerminal(type: "cancelled" | "error", code: FailureCode = "worker_failed", stage?: FailureStage): Promise<void> {
    await this.publish(type, type === "error" ? { code, ...(stage ? { stage } : {}) } : {});
  }

  private provider(modelId: string) {
    const model: Model<"openai-completions"> = {
      id: modelId,
      name: "Configured health model",
      api: "openai-completions",
      provider: "wild-hearts-gateway",
      // The model endpoint is a gateway-owned proxy, never caller supplied.
      baseUrl: new URL("/v1/inference", this.options.gatewayUrl).toString(),
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: this.options.contextWindow ?? 32_768,
      maxTokens: this.options.maxTokens ?? 6_144,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "qwen", thinkingTokenBudgetField: "thinking_budget" },
    };
    return createProvider({
      id: "wild-hearts-gateway",
      name: "Wild Hearts private inference gateway",
      auth: { apiKey: { name: "Run capability", resolve: async () => ({ auth: { headers: { authorization: `Bearer ${this.options.capability}` } } }) } },
      models: [model],
      api: openAICompletionsApi(),
    });
  }

  private tool(name: ToolName, state: ToolRunState): AgentTool {
    return {
      name,
      label: name,
      description: toolDescription[name],
      parameters: toolParameters[name],
      executionMode: "sequential",
      execute: async (toolCallId, parameters, signal) => {
        const callNumber = state.nextCall();
        const stage = toolFailureStage(name);
        if (callNumber >= CHAT_MAX_TOOL_CALLS) state.disable();
        if (callNumber > CHAT_MAX_TOOL_CALLS) {
          const failure: ToolFailureInfo = { code: "tool_limit_reached", stage };
          state.failure(toolCallId, failure);
          return safeToolFailureResult(failure, 0);
        }
        const gateway = new GatewayToolClient(this.options.gatewayUrl, this.options.capability);
        try {
          const result = await gateway.execute(toolCallId, name, parameters as Record<string, unknown>, signal ?? new AbortController().signal);
          const failed = isToolReplyFailure(result);
          if (failed) state.failure(toolCallId, { code: "tool_unavailable", stage });
          const withBudget = addRemainingToolCalls(result, state.remaining());
          return { content: [{ type: "text", text: JSON.stringify(withBudget) }], details: {}, ...(failed ? { isError: true } : {}) };
        } catch (error) {
          const failure: ToolFailureInfo = { code: error instanceof GatewayToolError ? error.code : "tool_unavailable", stage };
          if (failure.code === "tool_limit_reached") state.exhaust();
          state.failure(toolCallId, failure);
          return safeToolFailureResult(failure, state.remaining());
        }
      },
    };
  }

  private async publish(type: WorkerEventType, data: Record<string, unknown>): Promise<boolean> {
    const event = { eventId: randomUUID(), sequence: this.sequence + 1, type, data };
    const encodedBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    const isProgress = type === "answer.delta" || type === "reasoning.delta";
    if (isProgress && (this.progressEventCount >= 128 || this.progressEventBytes + encodedBytes > 64 * 1024)) return false;
    if ((type === "message.completed" || type === "completed") && encodedBytes > 32_000) {
      throw new WorkerExecutionError("event_publish_failed", "event_publish");
    }
    this.sequence += 1;
    if (isProgress) {
      this.progressEventCount += 1;
      this.progressEventBytes += encodedBytes;
    }
    try {
      await this.emit(event);
      return true;
    } catch {
      throw new WorkerExecutionError("event_publish_failed", "event_publish");
    }
  }
}

type FailureCode = "worker_failed" | "worker_timeout" | "inference_unavailable" | "tool_limit_reached" | "tool_unavailable" | "context_unavailable" | "event_publish_failed";
type FailureStage = "context" | "inference" | "record_lookup" | "note_lookup" | "research" | "event_publish" | "deadline";
type ToolFailureInfo = Readonly<{ code: "tool_limit_reached" | "tool_unavailable"; stage: "record_lookup" | "note_lookup" | "research" }>;
type ToolRunState = Readonly<{
  nextCall(): number;
  remaining(): number;
  disable(): void;
  exhaust(): void;
  failure(toolCallId: string, failure: ToolFailureInfo): void;
}>;


function toolFailureStage(tool: ToolName): ToolFailureInfo["stage"] {
  if (tool === "read_stored_note") return "note_lookup";
  if (tool === "search_research" || tool === "read_research") return "research";
  return "record_lookup";
}

function isToolReplyFailure(result: unknown): boolean {
  return !!result && typeof result === "object" && "status" in result && (result as { status?: unknown }).status === "failed";
}

function addRemainingToolCalls(result: unknown, remainingToolCalls: number): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) return { ...(result as Record<string, unknown>), remainingToolCalls };
  return { status: "completed", result, remainingToolCalls };
}

function jsonStringContentBytes(value: string): number {
  let bytes = 0;
  for (const character of value) bytes += Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
  return bytes;
}

function finalAnswerEventBaseBytes(): number {
  const envelope = (type: "message.completed" | "completed", key: "content" | "answer") => Buffer.byteLength(JSON.stringify({
    eventId: "00000000-0000-0000-0000-000000000000",
    sequence: 999_999_999,
    type,
    data: { [key]: "" },
  }), "utf8");
  return envelope("message.completed", "content") + envelope("completed", "answer");
}

function safeToolFailureResult(failure: ToolFailureInfo, remainingToolCalls: number) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ status: "failed", errorCode: failure.code, remainingToolCalls }) }],
    details: {},
    isError: true,
  };
}

export class WorkerExecutionError extends Error {
  constructor(readonly code: FailureCode, readonly stage: FailureStage) {
    super(code);
    this.name = "WorkerExecutionError";
  }
}

export class WorkerTimeoutError extends WorkerExecutionError {
  constructor() { super("worker_timeout", "deadline"); this.name = "WorkerTimeoutError"; }
}

export type WorkerTerminalOutcome = Readonly<{ type: "cancelled" } | { type: "error"; code: FailureCode; stage: FailureStage }>;

/** Shutdown is not a user cancellation unless the web authority confirms it. */
export async function classifyWorkerFailure(error: unknown, _shutdownSignal: AbortSignal, checkWebCancellation: () => Promise<boolean>): Promise<WorkerTerminalOutcome> {
  if (error instanceof WorkerTimeoutError) return { type: "error", code: error.code, stage: error.stage };
  try { if (await checkWebCancellation()) return { type: "cancelled" }; }
  catch { /* an unavailable authority cannot confirm user cancellation */ }
  if (error instanceof WorkerExecutionError) return { type: "error", code: error.code, stage: error.stage };
  return { type: "error", code: "worker_failed", stage: "inference" };
}

/** Entry point used by Iggy's fixed health-chat image; it writes no prompt or answer to stdout. */
export async function runWorkerFromEnvironment(): Promise<void> {
  const capability = process.env.IGGY_BROKER_CAPABILITY;
  const gatewayUrl = process.env.IGGY_GATEWAY_URL;
  if (!capability || !gatewayUrl) throw new Error("health_worker_not_configured");
  const client = new GatewayToolClient(new URL(gatewayUrl), capability);
  const controller = new AbortController();
  const onShutdown = () => controller.abort();
  process.once("SIGTERM", onShutdown);
  process.once("SIGINT", onShutdown);
  let runner: PiHealthRunner | undefined;
  try {
    let context: Awaited<ReturnType<GatewayToolClient["loadContext"]>>;
    try { context = await client.loadContext(controller.signal); }
    catch { throw new WorkerExecutionError("context_unavailable", "context"); }
    runner = new PiHealthRunner({ capability, gatewayUrl: new URL(gatewayUrl), modelId: context.modelId, gatewayClient: client }, (event) => client.publish(event, ["cancelled", "error"].includes(event.type) ? AbortSignal.timeout(5_000) : controller.signal).then(() => undefined));
    await runner.run(controller.signal);
  } catch (error) {
    const outcome = await classifyWorkerFailure(error, controller.signal, () => client.cancelled(AbortSignal.timeout(5_000)));
    // Never serialize Error.message: providers may include request fragments.
    if (runner) await runner.publishTerminal(outcome.type, outcome.type === "error" ? outcome.code : undefined, outcome.type === "error" ? outcome.stage : undefined).catch(() => undefined);
    else await client.publish({ eventId: randomUUID(), sequence: 1, type: outcome.type, data: outcome.type === "error" ? { code: outcome.code, stage: outcome.stage } : {} }, AbortSignal.timeout(5_000)).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    process.off("SIGTERM", onShutdown);
    process.off("SIGINT", onShutdown);
  }
}
const toolParameters: Record<ToolName, ReturnType<typeof Type.Unsafe>> = Object.fromEntries(toolNames.map((name) => [name, Type.Unsafe(chatToolJsonSchemas[name])])) as Record<ToolName, ReturnType<typeof Type.Unsafe>>;
const toolDescription: Record<ToolName, string> = chatToolDescriptions;
