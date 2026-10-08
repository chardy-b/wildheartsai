import { foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { fhirAttachment, fhirResource } from "./records-schema";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

// All readable chat material is sealed with the person's existing per-user data key. Plaintext
// fields support ownership, ordering, recovery, and bounded retrieval only.
export const chatConversation = pgTable(
  "chat_conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sealedTitle: text("sealed_title"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    nextMessageSequence: integer("next_message_sequence").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("chat_conversation_user_id_idx").on(table.userId, table.id),
    index("chat_conversation_user_updated_idx").on(table.userId, table.updatedAt.desc()),
  ],
);

export const chatMessage = pgTable(
  "chat_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversation.id, { onDelete: "cascade" }),
    // Sequence is allocated from the conversation in the same transaction as the insert.
    sequence: integer("sequence").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    status: text("status", { enum: ["pending", "completed", "failed", "cancelled"] }).notNull(),
    sealedContent: text("sealed_content").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("chat_message_conversation_sequence_idx").on(table.conversationId, table.sequence),
    uniqueIndex("chat_message_owner_parent_idx").on(table.userId, table.conversationId, table.id),
    index("chat_message_user_conversation_idx").on(table.userId, table.conversationId, table.sequence),
    foreignKey({ columns: [table.userId, table.conversationId], foreignColumns: [chatConversation.userId, chatConversation.id] }),
  ],
);

export const chatRun = pgTable(
  "chat_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversation.id, { onDelete: "cascade" }),
    parentMessageId: uuid("parent_message_id")
      .notNull()
      .references(() => chatMessage.id, { onDelete: "cascade" }),
    assistantMessageId: uuid("assistant_message_id").references(() => chatMessage.id, { onDelete: "set null" }),
    status: text("status", { enum: ["queued", "running", "completed", "failed", "cancelled", "interrupted"] }).notNull().default("queued"),
    // User-supplied request ids make retries safe without exposing prompt content.
    idempotencyKey: text("idempotency_key").notNull(),
    // Config versions and usage counts are non-content metadata. Never put prompts or provider
    // request/response bodies here.
    executionMeta: jsonb("execution_meta").$type<Record<string, number | string | boolean | null>>().notNull().default({}),
    // Internal Better Auth row id, never its cookie/token. No cascading session FK: logout
    // revokes authority while preserving the conversation and its encrypted audit history.
    initiatingSessionId: text("initiating_session_id"),
    coordinatorId: uuid("coordinator_id").references(() => chatCoordinator.id),
    claimRequestId: uuid("claim_request_id"),
    grantedWorkerId: text("granted_worker_id"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    executionGrantHash: text("execution_grant_hash"),
    controlGrantHash: text("control_grant_hash"),
    grantsRevokedAt: timestamp("grants_revoked_at", { withTimezone: true }),
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
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

export const chatToolCall = pgTable(
  "chat_tool_call",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversation.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => chatRun.id, { onDelete: "cascade" }),
    callOrder: integer("call_order").notNull(),
    toolName: text("tool_name").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed", "cancelled"] }).notNull().default("pending"),
    requestDigest: text("request_digest"),
    sealedArguments: text("sealed_arguments").notNull(),
    sealedContext: text("sealed_context"),
    sealedResult: text("sealed_result"),
    // Counts, coverage and truncation flags explain a tool action without duplicating results.
    resultMeta: jsonb("result_meta").$type<Record<string, number | string | boolean | null>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("chat_tool_call_run_order_idx").on(table.runId, table.callOrder),
    index("chat_tool_call_user_run_idx").on(table.userId, table.runId, table.callOrder),
    foreignKey({ columns: [table.userId, table.conversationId, table.runId], foreignColumns: [chatRun.userId, chatRun.conversationId, chatRun.id] }),
  ],
);

// Events are intentionally small, sanitized, and sealed. Raw runner/provider events are never
// persisted. Sequence is allocated by appendChatEvent for reconnect-safe replay.
export const chatEvent = pgTable(
  "chat_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversation.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => chatRun.id, { onDelete: "cascade" }),
    // Stable id assigned by Iggy/the broker. Replayed worker delivery is deduplicated by this
    // value without retaining the original event payload in plaintext.
    eventId: uuid("event_id").notNull(),
    attempt: integer("attempt").notNull(),
    workerSequence: integer("worker_sequence").notNull(),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    requestDigest: text("request_digest"),
    sealedPayload: text("sealed_payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_event_run_sequence_idx").on(table.runId, table.sequence),
    uniqueIndex("chat_event_run_attempt_event_idx").on(table.runId, table.attempt, table.eventId),
    uniqueIndex("chat_event_run_attempt_worker_sequence_idx").on(table.runId, table.attempt, table.workerSequence),
    index("chat_event_user_run_idx").on(table.userId, table.runId, table.sequence),
    foreignKey({ columns: [table.userId, table.conversationId, table.runId], foreignColumns: [chatRun.userId, chatRun.conversationId, chatRun.id] }),
  ],
);

export const userSummary = pgTable(
  "user_summary",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    originatingRunId: uuid("originating_run_id").references(() => chatRun.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    sealedTitle: text("sealed_title").notNull(),
    sealedContent: text("sealed_content").notNull(),
    freshness: text("freshness", { enum: ["fresh", "stale"] }).notNull().default("fresh"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("user_summary_user_idempotency_idx").on(table.userId, table.idempotencyKey),
    uniqueIndex("user_summary_owner_parent_idx").on(table.userId, table.id),
    index("user_summary_user_updated_idx").on(table.userId, table.updatedAt.desc()),
  ],
);

// The opaque evidence row id is the citation handle shown to the agent. The underlying record
// and attachment ids are server-side only and are re-authorized on every use.
export const summaryEvidence = pgTable(
  "summary_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    summaryId: uuid("summary_id")
      .notNull()
      .references(() => userSummary.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["record", "note"] }).notNull(),
    recordId: uuid("record_id").references(() => fhirResource.id, { onDelete: "set null" }),
    attachmentId: uuid("attachment_id").references(() => fhirAttachment.id, { onDelete: "set null" }),
    sealedReference: text("sealed_reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("summary_evidence_user_summary_idx").on(table.userId, table.summaryId),
    foreignKey({ columns: [table.userId, table.summaryId], foreignColumns: [userSummary.userId, userSummary.id] }),
  ],
);

// Operational metadata only, no tenant content or standing tenant data authority. Its
// row lock serializes bounded claims and atomically fences operator disablement.
export const chatCoordinator = pgTable("chat_coordinator", {
  id: uuid("id").primaryKey().defaultRandom(),
  credentialHash: text("credential_hash").notNull(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  claimWindowAt: timestamp("claim_window_at", { withTimezone: true }).notNull().defaultNow(),
  claimCount: integer("claim_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("chat_coordinator_credential_idx").on(table.credentialHash)]);
