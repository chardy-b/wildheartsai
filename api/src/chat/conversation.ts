import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, section, type Conversation, type ToolRegistration, type Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { CHAT_MAX_TOOL_CALLS, chatToolDescriptions, chatToolJsonSchemas, chatToolSchemas, researchToolSchemas } from "@/lib/chat/tools";
import { describeToolActivity, summarizeToolActivity } from "@/lib/chat/tool-activity";
import { holoSystemPrompt } from "../../../services/chat/src/system-prompt";
import type { Fence, Receipt } from "../data/chat-records";
import { edgeConfig, ChatRequestError, type ChatBindings, type EdgeConfig } from "./env";
import { recallSummaries, saveSummary, SummaryEvidenceError } from "./data/summaries";

// One conversation, in its own Durable Object, running the Pi durable agent (docs/superpowers/
// specs/2026-10-07-web-owned-chat-security-boundary.md, "Cloudflare topology").
//
// Pi durable keeps the transcript and runs each answer as checkpointed tasks over this object's
// SQLite storage; the alarm resumes unfinished work after an eviction, restart or deploy. Next to
// Pi's tables, this object keeps what the browser reads (`wh_*`): messages, runs, the events a
// run's page polls for, and each tool call with its read receipts. Runs are settled from Pi's
// submission state, on every watched commit and every poll, so a missed event can't strand one.

const context = BACKGROUND_CONTEXT;
const HEARTBEAT_MS = 60_000;
const REASONING_LIMIT_BYTES = 16 * 1024;
const PROVIDER = "wild-hearts-edge";
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

export type ConversationMeta = { conversationId: string; ownerId: string; recordsUserId: string; demo: boolean; expiresAt: number | null };
export type RunView = { id: string; conversationId: string; parentMessageId: string; assistantMessageId: string | null; status: string; attempt: number; cancellationRequestedAt: Date | null; createdAt: Date; startedAt: Date | null; completedAt: Date | null };
export type MessageView = { id: string; sequence: number; role: "user" | "assistant"; status: string; content: string; createdAt: Date; completedAt: Date | null; truncated: boolean };
export type ChatEvent = { sequence: number; kind: string; payload: Record<string, unknown>; createdAt: Date };

type RunRow = {
  id: string; idempotency_key: string; parent_message_id: string; assistant_message_id: string | null; status: string; fence: string;
  submission_id: string | null; cancel_requested_at: number | null; failure_code: string | null; created_at: number; started_at: number | null; completed_at: number | null;
  answer_key: string | null; answer_text: string; answer_chars: number; reasoning_chars: number; reasoning_bytes: number;
};
type ToolCallRow = { call_id: string; run_id: string; call_order: number; tool: string; status: string; receipts: string; output: string | null };
type Row = Record<string, SqlStorageValue>;

const RECORD_TOOLS = { get_data_coverage: "dataCoverage", find_records: "findRecords", read_records: "readRecords", read_stored_note: "readStoredNote", calculate_lab_trend: "labTrend" } as const;
type RecordTool = keyof typeof RECORD_TOOLS;

export class ChatConversation extends DurableObject<ChatBindings> {
  #harness: Harness | undefined;
  #root: Conversation | undefined;
  #edge: EdgeConfig | null;

  constructor(ctx: DurableObjectState, env: ChatBindings) {
    super(ctx, env);
    this.#edge = edgeConfig(env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#schema();
      // A fallback before anything can throw: an object whose open fails is started again.
      const fallback = Date.now() + HEARTBEAT_MS;
      const current = await ctx.storage.getAlarm();
      if (current === null || current > fallback) await ctx.storage.setAlarm(fallback);
      if (this.#meta()) await this.#open();
      await this.#arm();
    });
  }

  // ---- lifecycle ----

  #schema() {
    this.ctx.storage.sql.exec(`
      create table if not exists wh_meta (key text primary key, value text not null);
      create table if not exists wh_message (id text primary key, sequence integer not null unique, role text not null, status text not null, content text not null, created_at integer not null, completed_at integer);
      create table if not exists wh_run (id text primary key, idempotency_key text not null unique, parent_message_id text not null, assistant_message_id text, status text not null, fence text not null, submission_id text, cancel_requested_at integer, failure_code text, created_at integer not null, started_at integer, completed_at integer, answer_key text, answer_text text not null default '', answer_chars integer not null default 0, reasoning_chars integer not null default 0, reasoning_bytes integer not null default 0);
      create table if not exists wh_event (sequence integer primary key autoincrement, run_id text not null, kind text not null, payload text not null, created_at integer not null);
      create table if not exists wh_tool_call (call_id text primary key, run_id text not null, call_order integer not null, tool text not null, status text not null, receipts text not null default '[]', output text, created_at integer not null);
    `);
  }

  #meta(): ConversationMeta | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>("select value from wh_meta where key = 'meta'").toArray()[0];
    return row ? (JSON.parse(row.value) as ConversationMeta) : null;
  }

  #requireMeta(): ConversationMeta {
    const meta = this.#meta();
    if (!meta) throw new ChatRequestError(404, "not_found");
    return meta;
  }

  // Called once when the chat Worker creates the conversation.
  async init(meta: ConversationMeta): Promise<void> {
    if (!this.#meta()) this.ctx.storage.sql.exec("insert into wh_meta (key, value) values ('meta', ?)", JSON.stringify(meta));
    await this.#open();
    await this.#arm();
  }

  async #open() {
    if (this.#harness) return;
    const meta = this.#requireMeta();
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const models = createModels();
    const edge = this.#edge;
    if (edge) {
      const model: Model<"openai-completions"> = {
        id: edge.modelId, name: "Configured health model", api: "openai-completions", provider: PROVIDER,
        baseUrl: `${edge.url}/v1/inference`, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768, maxTokens: 6_144,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "qwen", thinkingTokenBudgetField: "thinking_budget" },
      };
      models.setProvider(createProvider({ id: PROVIDER, name: "Wild Hearts inference relay", auth: { apiKey: { name: "Edge token", resolve: async () => ({ auth: { headers: { authorization: `Bearer ${edge.token}` } } }) } }, models: [model], api: openAICompletionsApi() }));
    }
    const registry = createRegistry();
    registry.install(this.#extension(meta));
    this.#harness = await Harness.open(storage, {
      models, registry,
      settings: { retry: { maxRetries: 2 }, restartLimit: 3, afterFailedRun: "withdraw", toolExecution: "sequential" },
      onWake: (wake) => void this.#arm(wake).catch(() => this.ctx.abort("alarm write failed")),
    }, context);
    this.#root = await this.#harness.root(context, {
      agent: {
        ...(edge ? { model: { provider: PROVIDER, modelId: edge.modelId } } : {}),
        thinkingLevel: "low", maxTurns: 8,
        ...(meta.demo ? { instructions: "This conversation is in the Wild Hearts demo. The records belong to a fictional patient, Alex Morgan; say so if asked. Saving summaries isn't available here." } : {}),
      },
    });
    await this.#arm({ ...this.#harness.wake(), active: true });
    this.#harness.resume();
    // Turns committed progress into the deltas the browser polls for, and settles finished runs.
    const watch = await this.#root.watch(context);
    watch.start(async (call) => {
      if (call.kind === "value") await this.#onView(call.value);
    });
    await this.#recover();
  }

  // Keeps the alarm armed: a heartbeat while work runs, never later than Pi's earliest sleep, and
  // the demo expiry (a demo conversation deletes itself a day after its last question).
  async #arm(wake: Wake = this.#harness?.wake() ?? { active: false }) {
    const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined;
    const expiry = this.#meta()?.expiresAt ?? undefined;
    const times = [heartbeat, wake.at, expiry].filter((t): t is number => t !== undefined);
    if (!times.length) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
  }

  override async alarm() {
    const meta = this.#meta();
    if (meta?.expiresAt && Date.now() >= meta.expiresAt && !this.#activeRun()) return this.destroy();
    if (!this.#harness && meta) await this.#open();
    if (!this.#harness) return;
    await this.#arm({ ...this.#harness.wake(), active: true });
    this.#harness.resume();
    await this.#settleAll();
    await this.#arm();
  }

  // Deletes everything this conversation stored. The chat Worker removes its index rows.
  async destroy(): Promise<void> {
    if (this.#root) await this.#root.abort(context).catch(() => undefined);
    if (this.#harness) await this.#harness.close(context).catch(() => undefined);
    this.#harness = undefined;
    this.#root = undefined;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#schema();
  }

  // ---- runs ----

  // A question, as a run. One run at a time; the same idempotency key finds the same run.
  async submit(input: { runId: string; idempotencyKey: string; message: string; fence: Fence; expiresAt: number | null }): Promise<{ runId: string; status: string; created: boolean }> {
    const meta = this.#requireMeta();
    if (!this.#edge) throw new ChatRequestError(503, "chat_unavailable");
    const prior = this.#one<RunRow>("select * from wh_run where idempotency_key = ?", input.idempotencyKey);
    if (prior) return { runId: prior.id, status: prior.status, created: false };
    if (this.#activeRun()) throw new ChatRequestError(409, "conversation_busy");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const messageId = crypto.randomUUID();
      this.ctx.storage.sql.exec("insert into wh_message (id, sequence, role, status, content, created_at, completed_at) values (?, ?, 'user', 'completed', ?, ?, ?)", messageId, this.#nextSequence(), input.message, now, now);
      this.ctx.storage.sql.exec("insert into wh_run (id, idempotency_key, parent_message_id, status, fence, created_at) values (?, ?, ?, 'queued', ?, ?)", input.runId, input.idempotencyKey, messageId, JSON.stringify(input.fence), now);
      if (meta.demo && input.expiresAt) this.ctx.storage.sql.exec("update wh_meta set value = ? where key = 'meta'", JSON.stringify({ ...meta, expiresAt: input.expiresAt }));
    });
    await this.#start(input.runId);
    return { runId: input.runId, status: "running", created: true };
  }

  async #start(runId: string) {
    await this.#open();
    const run = this.#one<RunRow>("select * from wh_run where id = ?", runId)!;
    const message = this.#one<{ content: string }>("select content from wh_message where id = ?", run.parent_message_id)!;
    await this.#arm({ ...this.#harness!.wake(), active: true });
    // The run's id is Pi's request id: a retried start finds the same submission.
    const submission = await this.#root!.submit({ type: "input", content: message.content, requestId: run.id }, context);
    this.ctx.storage.sql.exec("update wh_run set status = 'running', submission_id = ?, started_at = coalesce(started_at, ?) where id = ? and status = 'queued'", submission.id, Date.now(), run.id);
    this.#event(run.id, "run.started", { status: "running" });
  }

  // A run recorded but not handed to Pi (the object stopped in between) is handed over now.
  async #recover() {
    for (const run of this.#all<RunRow>("select * from wh_run where status = 'queued' and submission_id is null")) await this.#start(run.id);
    await this.#settleAll();
  }

  async cancel(runId: string): Promise<string> {
    this.#requireMeta();
    const run = this.#one<RunRow>("select * from wh_run where id = ?", runId);
    if (!run) throw new ChatRequestError(404, "not_found");
    if (TERMINAL.includes(run.status)) return run.status;
    this.ctx.storage.sql.exec("update wh_run set cancel_requested_at = coalesce(cancel_requested_at, ?) where id = ?", Date.now(), runId);
    await this.#open();
    await this.#root!.abort(context);
    await this.#settleAll();
    return "cancelling";
  }

  #activeRun(): RunRow | null {
    return this.#one<RunRow>("select * from wh_run where status in ('queued', 'running') order by created_at desc limit 1");
  }

  // Stops the active run because its session ended; settling records why. Not awaited by the
  // tool or hook that finds it: the abort waits for them to finish.
  #stopForSession(runId: string) {
    this.ctx.storage.sql.exec("update wh_run set failure_code = coalesce(failure_code, 'session_ended') where id = ?", runId);
    const root = this.#root;
    if (root) void root.abort(context).catch(() => undefined).then(() => this.#settleAll());
  }

  async #fenceHolds(run: RunRow): Promise<boolean> {
    return (await this.env.RECORDS.sessionFence(JSON.parse(run.fence) as Fence)) !== null;
  }

  async #settleAll() {
    if (!this.#harness || !this.#root) return;
    for (const run of this.#all<RunRow>("select * from wh_run where status = 'running' and submission_id is not null")) {
      const submission = await this.#harness.submission(run.submission_id! as never, context);
      const record = submission ? await submission.status(context) : undefined;
      if (!record || record.status === "queued" || record.status === "placed") continue;
      if (record.status === "done") {
        const answer = (await this.#root.entries({ minEntryId: record.answer, maxEntryId: record.answer }, 1, undefined, context)).items[0];
        const message = answer?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
        this.#finish(run, "completed", (message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""));
      } else {
        const reason = (record as { reason?: string }).reason ?? "run_failed";
        const fresh = this.#one<RunRow>("select * from wh_run where id = ?", run.id)!;
        if (fresh.failure_code === "session_ended") this.#finish(run, "interrupted", undefined, { code: "session_ended", stage: "authorization" });
        else if (fresh.cancel_requested_at !== null || reason === "aborted") this.#finish(run, "cancelled");
        else this.#finish(run, reason === "interrupted" || reason === "restart_limit" ? "interrupted" : "failed", undefined, { code: reason === "turn_limit" ? "turn_limit" : "worker_failed", stage: "inference" });
      }
    }
  }

  #finish(run: RunRow, status: "completed" | "failed" | "cancelled" | "interrupted", answer?: string, failure?: { code: string; stage: string }) {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const current = this.#one<RunRow>("select status from wh_run where id = ?", run.id)!;
      if (TERMINAL.includes(current.status)) return;
      let assistantId: string | null = null;
      if (answer !== undefined) {
        assistantId = crypto.randomUUID();
        this.ctx.storage.sql.exec("insert into wh_message (id, sequence, role, status, content, created_at, completed_at) values (?, ?, 'assistant', 'completed', ?, ?, ?)", assistantId, this.#nextSequence(), answer, now, now);
      }
      this.ctx.storage.sql.exec("update wh_run set status = ?, assistant_message_id = ?, completed_at = ? where id = ?", status, assistantId, now, run.id);
      if (status === "completed") {
        // Partial text is committed every 100 ms at most, so a quick answer may end before any
        // of it was seen: send what the browser hasn't had yet.
        const streamed = this.#one<RunRow>("select answer_text from wh_run where id = ?", run.id)!.answer_text;
        const rest = answer?.startsWith(streamed) ? answer.slice(streamed.length) : streamed === "" ? answer : "";
        if (rest) this.#event(run.id, "answer.delta", { text: rest });
        this.#event(run.id, "answer.completed", {});
      }
      const kind = status === "completed" ? "run.completed" : status === "cancelled" ? "run.cancelled" : "run.failed";
      this.#event(run.id, kind, { status: status === "interrupted" ? "failed" : status, ...(failure ?? {}) });
    });
  }

  // Answer and reasoning text, as Pi commits it, into deltas; then settle anything finished.
  async #onView(view: unknown) {
    const live = (view as { docs?: Record<string, unknown> }).docs?.["pi.live"] as { run?: { turns?: number }; generation?: { attempt?: number; message?: { content?: { type: string; text?: string; thinking?: string }[] } } } | undefined;
    const run = this.#one<RunRow>("select * from wh_run where status = 'running' order by created_at desc limit 1");
    const message = live?.generation?.message;
    if (run && message?.content) {
      const key = `${live?.run?.turns ?? 0}:${live?.generation?.attempt ?? 0}`;
      let { answer_chars: answerChars, reasoning_chars: reasoningChars, reasoning_bytes: reasoningBytes } = run;
      if (run.answer_key !== key) [answerChars, reasoningChars] = [0, 0];
      const text = message.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      const thinking = message.content.filter((c) => c.type === "thinking").map((c) => c.thinking ?? "").join("");
      if (text.length > answerChars) this.#event(run.id, "answer.delta", { text: text.slice(answerChars) });
      if (thinking.length > reasoningChars && reasoningBytes < REASONING_LIMIT_BYTES) {
        const added = thinking.slice(reasoningChars);
        const room = REASONING_LIMIT_BYTES - reasoningBytes;
        const bytes = new TextEncoder().encode(added);
        const kept = bytes.length > room ? new TextDecoder().decode(bytes.slice(0, room)).replace(/�$/, "") : added;
        this.#event(run.id, "reasoning.delta", { text: kept, ...(bytes.length > room ? { truncated: true } : {}) });
        reasoningBytes += new TextEncoder().encode(kept).length;
      }
      const streamed = text.length >= answerChars ? text : run.answer_key === key ? run.answer_text : "";
      this.ctx.storage.sql.exec("update wh_run set answer_key = ?, answer_text = ?, answer_chars = ?, reasoning_chars = ?, reasoning_bytes = ? where id = ?", key, streamed, Math.max(answerChars, text.length), Math.max(reasoningChars, thinking.length), reasoningBytes, run.id);
    }
    if (!live?.run) await this.#settleAll();
  }

  // ---- tools ----

  #extension(meta: ConversationMeta) {
    const recordTool = (name: RecordTool): ToolRegistration => defineTool({
      name, description: chatToolDescriptions[name], parameters: chatToolJsonSchemas[name], replay: "safe",
      execute: (args, api) => this.#tool(api.callId, name, args, async () => {
        const method = RECORD_TOOLS[name];
        return this.env.RECORDS[method](meta.recordsUserId, chatToolSchemas[name].parse(args)) as Promise<{ output: unknown; receipts: Receipt[] }>;
      }),
    });
    const tools: ToolRegistration[] = (Object.keys(RECORD_TOOLS) as RecordTool[]).map(recordTool);
    tools.push(defineTool({
      name: "find_saved_summaries", description: chatToolDescriptions.find_saved_summaries, parameters: chatToolJsonSchemas.find_saved_summaries, replay: "safe",
      execute: (args, api) => this.#tool(api.callId, "find_saved_summaries", args, async () => {
        const input = chatToolSchemas.find_saved_summaries.parse(args);
        return { output: await recallSummaries(this.env, meta.ownerId, meta.recordsUserId, input.query, input.limit), receipts: [] };
      }),
    }));
    // Not for the demo: nothing a demo viewer does is kept.
    if (!meta.demo) {
      tools.push(defineTool({
        name: "save_summary", description: chatToolDescriptions.save_summary, parameters: chatToolJsonSchemas.save_summary, replay: "safe",
        execute: (args, api) => this.#tool(api.callId, "save_summary", args, async (run) => {
          const input = chatToolSchemas.save_summary.parse(args);
          const receipts = this.#all<ToolCallRow>("select receipts from wh_tool_call where run_id = ? and status = 'completed'", run.id).flatMap((c) => JSON.parse(c.receipts) as Receipt[]);
          const saved = await saveSummary(this.env, { ownerId: meta.ownerId, recordsUserId: meta.recordsUserId, runId: run.id, idempotencyKey: api.callId, receipts, ...input });
          return { output: saved, receipts: [] };
        }),
      }));
    }
    for (const name of ["search_research", "read_research"] as const) {
      tools.push(defineTool({
        name, description: chatToolDescriptions[name], parameters: chatToolJsonSchemas[name], replay: "safe",
        execute: (args, api) => this.#tool(api.callId, name, args, async () => ({ output: await this.#research(name, researchToolSchemas[name].parse(args)), receipts: [] })),
      }));
    }
    return defineExtension({
      name: "holo",
      sections: [section("holo", () => holoSystemPrompt, { tag: false })],
      tools,
      hooks: [
        // Before every model request (retries and recovery included): the run's session must
        // still hold, or the run stops.
        hook(GenerationTask, {
          beforeRequest: async () => {
            const run = this.#activeRun();
            if (run && !(await this.#fenceHolds(run))) {
              this.#stopForSession(run.id);
              throw new Error("session_ended");
            }
            return undefined;
          },
        }),
      ],
    });
  }

  // One tool call: counted against the run's budget, the session checked, recorded with its
  // receipts (a replay after a restart answers from the record), and shown to the browser.
  async #tool(callId: string, tool: string, args: unknown, work: (run: RunRow) => Promise<{ output: unknown; receipts: Receipt[] }>) {
    const run = this.#activeRun();
    const failure = (code: string, remaining = 0) => ({ output: [{ type: "text" as const, text: JSON.stringify({ status: "failed", errorCode: code, remainingToolCalls: remaining }) }], isError: true });
    if (!run || run.cancel_requested_at !== null) return failure("run_not_active");
    const done = this.#one<ToolCallRow>("select * from wh_tool_call where call_id = ?", callId);
    const used = this.#one<{ n: number }>("select count(*) as n from wh_tool_call where run_id = ?", run.id)!.n;
    if (done?.status === "completed" && done.output !== null) return { output: [{ type: "text" as const, text: JSON.stringify({ ...(JSON.parse(done.output) as object), remainingToolCalls: Math.max(0, CHAT_MAX_TOOL_CALLS - used) }) }] };
    if (!done && used >= CHAT_MAX_TOOL_CALLS) return failure("tool_limit_reached");
    const stage = tool.endsWith("_research") ? "research" : "records";
    if (!done) {
      this.ctx.storage.sql.exec("insert into wh_tool_call (call_id, run_id, call_order, tool, status, created_at) values (?, ?, ?, ?, 'running', ?)", callId, run.id, used, tool, Date.now());
      this.#event(run.id, "tool.started", { toolCallId: callId, tool, description: describeToolActivity(tool, args) });
      // The browser starts the answer over after a tool; so does what counts as streamed.
      this.ctx.storage.sql.exec("update wh_run set answer_text = '' where id = ?", run.id);
    }
    const started = Date.now();
    const remaining = CHAT_MAX_TOOL_CALLS - (done ? used : used + 1);
    if (!(await this.#fenceHolds(run))) {
      this.#stopForSession(run.id);
      this.#event(run.id, "tool.completed", { toolCallId: callId, tool, status: "failed", code: "session_ended", stage: "authorization", durationMs: Date.now() - started });
      return failure("run_not_active", remaining);
    }
    try {
      const { output, receipts } = await work(run);
      const outputText = JSON.stringify(output);
      this.ctx.storage.sql.exec("update wh_tool_call set status = 'completed', receipts = ?, output = ? where call_id = ?", JSON.stringify(receipts), outputText, callId);
      this.#event(run.id, "tool.completed", { toolCallId: callId, tool, status: "completed", ...summarizeToolActivity(tool, output), durationMs: Date.now() - started });
      const shaped = output && typeof output === "object" && !Array.isArray(output) ? output : { result: output };
      return { output: [{ type: "text" as const, text: JSON.stringify({ ...shaped, remainingToolCalls: remaining }) }] };
    } catch (error) {
      const code = error instanceof SummaryEvidenceError ? error.message : stage === "research" ? "research_unavailable" : "tool_unavailable";
      this.ctx.storage.sql.exec("update wh_tool_call set status = 'failed' where call_id = ?", callId);
      this.#event(run.id, "tool.completed", { toolCallId: callId, tool, status: "failed", code, stage, durationMs: Date.now() - started });
      return failure(code, remaining);
    }
  }

  // Research runs on the VPS, against its corpus; nothing of the person's goes with it.
  async #research(tool: "search_research" | "read_research", input: unknown): Promise<unknown> {
    const edge = this.#edge;
    if (!edge) throw new Error("research_unavailable");
    const response = await fetch(`${edge.url}/v1/research/${tool === "search_research" ? "search" : "read"}`, {
      method: "POST", headers: { authorization: `Bearer ${edge.token}`, "content-type": "application/json" }, body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error("research_unavailable");
    return response.json();
  }

  // ---- what the browser reads ----

  async messagePage(before?: number): Promise<{ messages: MessageView[]; hasMore: boolean; nextBefore: number | null; runs: RunView[] }> {
    const meta = this.#requireMeta();
    await this.#settleAll();
    const rows = this.#all<Row>(`select * from wh_message ${before === undefined ? "" : "where sequence < ?"} order by sequence desc limit 21`, ...(before === undefined ? [] : [before]));
    const page = rows.slice(0, 20).reverse();
    const messages = page.map((m) => ({ id: String(m.id), sequence: Number(m.sequence), role: m.role as "user" | "assistant", status: String(m.status), content: String(m.content), createdAt: new Date(Number(m.created_at)), completedAt: m.completed_at === null ? null : new Date(Number(m.completed_at)), truncated: false }));
    const ids = messages.map((m) => m.id);
    const runs = this.#all<RunRow>("select * from wh_run order by created_at").filter((r) => ids.includes(r.parent_message_id) || (r.assistant_message_id && ids.includes(r.assistant_message_id)) || (before === undefined && !TERMINAL.includes(r.status)));
    return { messages, hasMore: rows.length > 20, nextBefore: rows.length > 20 ? messages[0].sequence : null, runs: runs.map((r) => this.#runView(meta, r)) };
  }

  async events(runId: string, after: number): Promise<{ events: ChatEvent[]; status: string; nextSequence: number }> {
    this.#requireMeta();
    await this.#settleAll();
    const run = this.#one<RunRow>("select status from wh_run where id = ?", runId);
    if (!run) throw new ChatRequestError(404, "not_found");
    const events = this.#all<Row>("select * from wh_event where run_id = ? and sequence > ? order by sequence limit 200", runId, after)
      .map((e) => ({ sequence: Number(e.sequence), kind: String(e.kind), payload: JSON.parse(String(e.payload)) as Record<string, unknown>, createdAt: new Date(Number(e.created_at)) }));
    return { events, status: run.status, nextSequence: events.at(-1)?.sequence ?? after };
  }

  // The run's read receipts, in the order they were read, for the record-sources panel (the
  // records RPC turns them into views). Summaries the run recalled add their evidence.
  async receipts(runId: string): Promise<(Receipt & { noteExcerpt?: string; viaSummary?: boolean })[]> {
    this.#requireMeta();
    if (!this.#one("select id from wh_run where id = ?", runId)) throw new ChatRequestError(404, "not_found");
    const seen = new Map<string, Receipt & { noteExcerpt?: string; viaSummary?: boolean }>();
    for (const call of this.#all<ToolCallRow>("select * from wh_tool_call where run_id = ? and status = 'completed' order by call_order", runId)) {
      const note = call.tool === "read_stored_note" && call.output ? (JSON.parse(call.output) as { text?: string }).text : undefined;
      for (const receipt of JSON.parse(call.receipts) as Receipt[]) {
        const key = `${receipt.kind}:${receipt.targetId}`;
        if (!seen.has(key)) seen.set(key, { ...receipt, ...(note ? { noteExcerpt: note } : {}) });
      }
    }
    return [...seen.values()];
  }

  async researchPage(runId: string, after?: number) {
    this.#requireMeta();
    if (!this.#one("select id from wh_run where id = ?", runId)) throw new ChatRequestError(404, "not_found");
    const rows = this.#all<ToolCallRow>("select * from wh_tool_call where run_id = ? and status = 'completed' and tool in ('search_research', 'read_research') and call_order + 1 > ? order by call_order limit 2", runId, after ?? 0);
    const calls = rows.slice(0, 1).map((r) => ({ callOrder: r.call_order + 1, tool: r.tool, output: JSON.parse(r.output ?? "null") as unknown }));
    return { calls, hasMore: rows.length > 1, nextAfter: rows.length > 1 ? calls[0].callOrder : null };
  }

  // ---- helpers ----

  #runView(meta: ConversationMeta, r: RunRow): RunView {
    const at = (v: number | null) => (v === null ? null : new Date(v));
    return { id: r.id, conversationId: meta.conversationId, parentMessageId: r.parent_message_id, assistantMessageId: r.assistant_message_id, status: r.status, attempt: 1, cancellationRequestedAt: at(r.cancel_requested_at), createdAt: new Date(r.created_at), startedAt: at(r.started_at), completedAt: at(r.completed_at) };
  }

  #event(runId: string, kind: string, payload: Record<string, unknown>) {
    this.ctx.storage.sql.exec("insert into wh_event (run_id, kind, payload, created_at) values (?, ?, ?, ?)", runId, kind, JSON.stringify(payload), Date.now());
  }

  #nextSequence(): number {
    return this.#one<{ n: number }>("select coalesce(max(sequence), 0) + 1 as n from wh_message")!.n;
  }

  #one<T>(query: string, ...bindings: SqlStorageValue[]): T | null {
    return (this.ctx.storage.sql.exec(query, ...bindings).toArray()[0] as T | undefined) ?? null;
  }

  #all<T>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[];
  }
}
