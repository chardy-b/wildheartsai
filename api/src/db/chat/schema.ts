import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { json, now, time, uuidPk } from "../columns";

// The chat D1 database (binding CHAT_DB), bound only to the chat Worker. It replaces the
// restricted Postgres roles: see docs/superpowers/specs/2026-10-30-d1-transaction-audit.md.
// Foreign keys to `user`, `fhir_resource` and `fhir_attachment` can't cross databases, so those
// columns are plain: account deletion removes chat rows through the chat Worker, and record
// references are re-authorized against the main database on every use.

const timestamps = {
  createdAt: time("created_at").notNull().default(now),
  updatedAt: time("updated_at").notNull().default(now),
};

// All readable chat material is sealed with the person's per-user data key. Plaintext fields
// support ownership, ordering, recovery, and bounded retrieval only.
export const chatConversation = sqliteTable(
  "chat_conversation",
  {
    id: uuidPk(),
    userId: text("user_id").notNull(),
    sealedTitle: text("sealed_title"),
    archivedAt: time("archived_at"),
    nextMessageSequence: integer("next_message_sequence").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("chat_conversation_user_id_idx").on(table.userId, table.id),
    index("chat_conversation_user_updated_idx").on(table.userId, sql`${table.updatedAt} desc`),
  ],
);

export const chatMessage = sqliteTable(
  "chat_message",
  {
    id: uuidPk(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull().references(() => chatConversation.id, { onDelete: "cascade" }),
    // Sequence is allocated from the conversation in the same batch as the insert.
    sequence: integer("sequence").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    status: text("status", { enum: ["pending", "completed", "failed", "cancelled"] }).notNull(),
    sealedContent: text("sealed_content").notNull(),
    completedAt: time("completed_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("chat_message_conversation_sequence_idx").on(table.conversationId, table.sequence),
    uniqueIndex("chat_message_owner_parent_idx").on(table.userId, table.conversationId, table.id),
    index("chat_message_user_conversation_idx").on(table.userId, table.conversationId, table.sequence),
    foreignKey({ columns: [table.userId, table.conversationId], foreignColumns: [chatConversation.userId, chatConversation.id] }),
  ],
);

// Operational metadata only, no tenant content or standing tenant data authority.
export const chatCoordinator = sqliteTable(
  "chat_coordinator",
  {
    id: uuidPk(),
    credentialHash: text("credential_hash").notNull(),
    disabledAt: time("disabled_at"),
    claimWindowAt: time("claim_window_at").notNull().default(now),
    claimCount: integer("claim_count").notNull().default(0),
    createdAt: time("created_at").notNull().default(now),
  },
  (table) => [uniqueIndex("chat_coordinator_credential_idx").on(table.credentialHash)],
);

export const chatRun = sqliteTable(
  "chat_run",
  {
    id: uuidPk(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull().references(() => chatConversation.id, { onDelete: "cascade" }),
    parentMessageId: text("parent_message_id").notNull().references(() => chatMessage.id, { onDelete: "cascade" }),
    assistantMessageId: text("assistant_message_id").references(() => chatMessage.id, { onDelete: "set null" }),
    status: text("status", { enum: ["queued", "running", "completed", "failed", "cancelled", "interrupted"] }).notNull().default("queued"),
    // User-supplied request ids make retries safe without exposing prompt content.
    idempotencyKey: text("idempotency_key").notNull(),
    // Config versions and usage counts only. Never prompts or provider request/response bodies.
    executionMeta: json<Record<string, number | string | boolean | null>>("execution_meta").notNull().default({}),
    // Internal Better Auth row id, never its cookie/token. No session FK: logout revokes
    // authority while preserving the conversation and its encrypted audit history.
    initiatingSessionId: text("initiating_session_id"),
    coordinatorId: text("coordinator_id").references(() => chatCoordinator.id),
    claimRequestId: text("claim_request_id"),
    grantedWorkerId: text("granted_worker_id"),
    deadlineAt: time("deadline_at"),
    executionGrantHash: text("execution_grant_hash"),
    controlGrantHash: text("control_grant_hash"),
    grantsRevokedAt: time("grants_revoked_at"),
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: time("next_attempt_at").notNull().default(now),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: time("lease_expires_at"),
    cancellationRequestedAt: time("cancellation_requested_at"),
    startedAt: time("started_at"),
    completedAt: time("completed_at"),
    nextEventSequence: integer("next_event_sequence").notNull().default(0),
    nextWorkerSequence: integer("next_worker_sequence").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("chat_run_user_idempotency_idx").on(table.userId, table.idempotencyKey),
    uniqueIndex("chat_run_coordinator_claim_idx").on(table.coordinatorId, table.claimRequestId),
    uniqueIndex("chat_run_execution_grant_idx").on(table.executionGrantHash),
    uniqueIndex("chat_run_control_grant_idx").on(table.controlGrantHash),
    uniqueIndex("chat_run_owner_parent_idx").on(table.userId, table.conversationId, table.id),
    index("chat_run_claim_idx").on(table.status, table.nextAttemptAt, table.leaseExpiresAt),
    index("chat_run_user_conversation_idx").on(table.userId, table.conversationId, table.createdAt),
    foreignKey({ columns: [table.userId, table.conversationId], foreignColumns: [chatConversation.userId, chatConversation.id] }),
    foreignKey({ columns: [table.userId, table.conversationId, table.parentMessageId], foreignColumns: [chatMessage.userId, chatMessage.conversationId, chatMessage.id] }),
    foreignKey({ columns: [table.userId, table.conversationId, table.assistantMessageId], foreignColumns: [chatMessage.userId, chatMessage.conversationId, chatMessage.id] }),
  ],
);

export const chatToolCall = sqliteTable(
  "chat_tool_call",
  {
    id: uuidPk(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull().references(() => chatConversation.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().references(() => chatRun.id, { onDelete: "cascade" }),
    callOrder: integer("call_order").notNull(),
    toolName: text("tool_name").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed", "cancelled"] }).notNull().default("pending"),
    requestDigest: text("request_digest"),
    sealedArguments: text("sealed_arguments").notNull(),
    sealedContext: text("sealed_context"),
    sealedResult: text("sealed_result"),
    // Counts, coverage and truncation flags explain a tool action without duplicating results.
    resultMeta: json<Record<string, number | string | boolean | null>>("result_meta").notNull().default({}),
    startedAt: time("started_at").notNull().default(now),
    completedAt: time("completed_at"),
  },
  (table) => [
    uniqueIndex("chat_tool_call_run_order_idx").on(table.runId, table.callOrder),
    index("chat_tool_call_user_run_idx").on(table.userId, table.runId, table.callOrder),
    foreignKey({ columns: [table.userId, table.conversationId, table.runId], foreignColumns: [chatRun.userId, chatRun.conversationId, chatRun.id] }),
  ],
);

// Events are small, sanitized, and sealed. Raw runner/provider events are never persisted.
export const chatEvent = sqliteTable(
  "chat_event",
  {
    id: uuidPk(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull().references(() => chatConversation.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().references(() => chatRun.id, { onDelete: "cascade" }),
    // Stable id assigned by Iggy/the broker; replayed delivery is deduplicated by it.
    eventId: text("event_id").notNull(),
    attempt: integer("attempt").notNull(),
    workerSequence: integer("worker_sequence").notNull(),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    requestDigest: text("request_digest"),
    sealedPayload: text("sealed_payload").notNull(),
    createdAt: time("created_at").notNull().default(now),
  },
  (table) => [
    uniqueIndex("chat_event_run_sequence_idx").on(table.runId, table.sequence),
    uniqueIndex("chat_event_run_attempt_event_idx").on(table.runId, table.attempt, table.eventId),
    uniqueIndex("chat_event_run_attempt_worker_sequence_idx").on(table.runId, table.attempt, table.workerSequence),
    index("chat_event_user_run_idx").on(table.userId, table.runId, table.sequence),
    foreignKey({ columns: [table.userId, table.conversationId, table.runId], foreignColumns: [chatRun.userId, chatRun.conversationId, chatRun.id] }),
  ],
);

export const userSummary = sqliteTable(
  "user_summary",
  {
    id: uuidPk(),
    userId: text("user_id").notNull(),
    originatingRunId: text("originating_run_id").references(() => chatRun.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    sealedTitle: text("sealed_title").notNull(),
    sealedContent: text("sealed_content").notNull(),
    freshness: text("freshness", { enum: ["fresh", "stale"] }).notNull().default("fresh"),
    deletedAt: time("deleted_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("user_summary_user_idempotency_idx").on(table.userId, table.idempotencyKey),
    uniqueIndex("user_summary_owner_parent_idx").on(table.userId, table.id),
    index("user_summary_user_updated_idx").on(table.userId, sql`${table.updatedAt} desc`),
  ],
);

// The opaque evidence row id is the citation handle shown to the agent. The record and
// attachment ids (main database) are server-side only and re-authorized on every use.
export const summaryEvidence = sqliteTable(
  "summary_evidence",
  {
    id: uuidPk(),
    userId: text("user_id").notNull(),
    summaryId: text("summary_id").notNull().references(() => userSummary.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["record", "note"] }).notNull(),
    recordId: text("record_id"),
    attachmentId: text("attachment_id"),
    sealedReference: text("sealed_reference").notNull(),
    createdAt: time("created_at").notNull().default(now),
  },
  (table) => [
    index("summary_evidence_user_summary_idx").on(table.userId, table.summaryId),
    foreignKey({ columns: [table.userId, table.summaryId], foreignColumns: [userSummary.userId, userSummary.id] }),
    check("summary_evidence_target_kind", sql`(${table.kind} = 'record' and ${table.attachmentId} is null) or (${table.kind} = 'note' and ${table.recordId} is null)`),
  ],
);
