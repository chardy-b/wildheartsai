import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../src/lib/db/schema.js";
import type { Db } from "../../../src/lib/db/types.js";
import * as store from "../../../src/lib/chat/store.js";
import * as queue from "../../../src/lib/chat/queue.js";
import { invokeRecordedChatTool } from "../../../src/lib/chat/gateway.js";
import { IggyClient } from "./iggy-client.js";
import { assertChatDatabaseRoles } from "./role-preflight.js";
import type { ChatRepository, ChatEventKind, ChatScope, WorkerEventType } from "./contracts.js";

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`missing_${name.toLowerCase()}`); return value; };
const scope = (value: Partial<ChatScope> & Pick<ChatScope, "userId">) => ({ userId: value.userId, ...(value.conversationId ? { conversationId: value.conversationId } : {}), ...(value.runId ? { runId: value.runId } : {}), ...(value.runAttempt ? { runAttempt: value.runAttempt } : {}), ...(value.workerId ? { workerId: value.workerId } : {}) });
const eventKinds: Record<WorkerEventType, ChatEventKind> = { lifecycle: "run.started", "answer.delta": "answer.delta", "tool.started": "tool.started", "tool.completed": "tool.completed", "message.completed": "answer.completed", "summary.suggested": "tool.completed", completed: "run.completed", cancelled: "run.cancelled", error: "run.failed" };

/** Concrete adapter shared by production and constrained-role integration tests. */
export function createRepository(db: Db, queueDb: Db): ChatRepository {
  return {
    listConversations: (s) => store.listConversations(db, scope(s)),
    createConversation: (s) => store.createConversation(db, scope(s)),
    getConversation: async (s) => {
      const conversation = await store.getConversation(db, scope(s));
      if (!conversation) return null;
      return { conversation, messages: await store.listMessages(db, scope(s)), runs: (await store.listRuns(db, scope(s))).map(({ completedAt, ...run }) => ({ ...run, completedAt: completedAt ?? undefined })) };
    },
    deleteConversation: (s) => store.deleteConversation(db, scope(s)),
    listSummaries: async (s) => (await store.listSummaries(db, scope(s))).map((x) => ({ id: x.id, title: x.title, content: { text: x.content.text }, createdAt: x.createdAt, updatedAt: x.updatedAt })),
    deleteSummary: (s, id) => store.deleteSummary(db, scope(s), id),
    createRun: async ({ scope: s, idempotencyKey, message }) => { const submitted = await store.submitQuestionAndRun(db, scope(s), { message, idempotencyKey }); return { runId: submitted.run.id, created: !submitted.duplicate }; },
    getRun: async (s, id) => { const run = await store.findRunForUser(db, scope(s), id); return run ? { id: run.id, status: run.status } : null; },
    findRunForUser: async (s, id) => { const run = await store.findRunForUser(db, scope(s), id); return run ? { id: run.id, conversationId: run.conversationId, status: run.status } : null; },
    interruptExpiredRuns: () => queueDb.transaction((tx) => queue.interruptExpiredRuns(tx as unknown as Db)),
    claimNextRun: async (workerId, leaseMs) => {
      const claimed = await queue.claimNextQueuedRun(queueDb, { workerId, leaseMs });
      if (!claimed) return null;
      // The isolated worker obtains canonical context only from the private gateway.
      // Discovery must not decrypt content or strand a newly claimed lease on a read failure.
      return { id: claimed.scope.runId, scope: { ...claimed.scope, credentialId: randomUUID(), expiresAt: claimed.leaseExpiresAt }, attempt: claimed.scope.runAttempt, leaseOwner: claimed.scope.workerId, messages: [] };
    },
    loadRunContext: async (s) => (await store.loadRunContext(db, scope(s))).messages.map(({ role, content }) => ({ role, content })),
    renewLease: (s, _worker, leaseMs) => store.renewLease(db, scope(s), { leaseMs }),
    isWorkerLeaseCurrent: async (s) => { try { await store.assertActiveWorker(db, scope(s)); return true; } catch { return false; } },
    isCancellationRequested: (s) => store.isCancellationRequested(db, scope(s)),
    requestCancellation: (s) => store.requestRunCancellation(db, scope(s)),
    appendWorkerEvent: async (s, event) => { const result = await store.appendWorkerEvent(db, scope(s), event); return result.status === "appended" ? "accepted" : result.status; },
    finalizeWorkerEvent: async (s, event, result) => { await store.finalizeWorkerEvent(db, scope(s), { event, status: result.status, assistantContent: result.answer }); },
    listEvents: async (s, after) => (await store.listEventsAfter(db, scope(s), after)).map((e) => {
      const kind = eventKinds[e.type as WorkerEventType];
      if (!kind) throw new Error("invalid_stored_event");
      return { sequence: e.sequence, kind, payload: e.type === "completed" ? { status: "completed" } : e.type === "message.completed" ? {} : e.type === "cancelled" ? {} : e.type === "error" ? { code: "worker_failed" } : e.data, createdAt: e.createdAt };
    }),
    finalizeServiceEvent: async (s, result) => { await store.finalizeServiceEvent(db, scope(s), { event: { eventId: randomUUID(), type: result.status === "cancelled" ? "cancelled" : "error", data: result.errorCode ? { code: result.errorCode } : {} }, status: result.status }); },
    invokeTool: async (s, request) => {
      const result = await invokeRecordedChatTool(db, scope(s), { providerToolCallId: request.toolCallId, tool: request.tool, rawInput: request.input });
      const raw = result.output;
      return { status: "completed", output: Array.isArray(raw) ? { items: raw } : raw && typeof raw === "object" ? raw as Record<string, unknown> : { value: raw } };
    },
  };
}

export async function createRuntime() {
  const dataUrl = required("CHAT_DATABASE_URL"); const queueUrl = required("CHAT_QUEUE_DATABASE_URL");
  if (dataUrl === queueUrl) throw new Error("queue_role_must_be_separate");
  const dataPool = new Pool({ connectionString: dataUrl, max: 5 }); const queuePool = new Pool({ connectionString: queueUrl, max: 2 });
  // Bridge duplicate installed Drizzle type identities once at each driver boundary.
  const db = drizzle(dataPool, { schema }) as unknown as Db; const queueDb = drizzle(queuePool, { schema }) as unknown as Db;
  const inferenceUrl = new URL(required("CHAT_INFERENCE_URL"));
  if (!/^https?:$/.test(inferenceUrl.protocol) || inferenceUrl.username || inferenceUrl.password || inferenceUrl.search || inferenceUrl.hash) throw new Error("invalid_inference_url");
  const model = required("CHAT_INFERENCE_MODEL"); const apiKey = process.env.CHAT_INFERENCE_API_KEY;
  return {
    repository: createRepository(db, queueDb),
    modelId: model,
    isSessionActive: async (sessionId: string, userId: string) => (await dataPool.query("select 1 from session s join \"user\" u on u.id=s.user_id where s.id=$1 and s.user_id=$2 and s.expires_at > now() and u.email_verified=true", [sessionId, userId])).rowCount === 1,
    assertQueueRoleReady: () => assertChatDatabaseRoles(dataPool, queuePool),
    close: async () => { await Promise.all([dataPool.end(), queuePool.end()]); },
    iggy: new IggyClient(new URL(required("IGGY_URL")), required("IGGY_BEARER_TOKEN")),
    modelProxy: async ({ path, body, signal }: { path: string; body: unknown; signal: AbortSignal }) => {
      if (path !== "/chat/completions" || !body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_inference_request");
      const input = body as Record<string, unknown>;
      const safe = { model, messages: input.messages, tools: input.tools, tool_choice: input.tool_choice, stream: input.stream === true, stream_options: input.stream_options, max_tokens: Math.max(1, Math.min(Number(input.max_tokens) || 2048, 2048)), temperature: typeof input.temperature === "number" ? input.temperature : 0 };
      return fetch(new URL(`${inferenceUrl.toString().replace(/\/$/, "")}/chat/completions`), { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(safe), signal });
    },
  };
}
