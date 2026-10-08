import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { canonicalJson, sealField, unsealField, userKeysFor, type UserKeys } from "@/lib/crypto/user-keys";
import {
  chatConversation,
  chatEvent,
  chatMessage,
  chatRun,
  chatToolCall,
  fhirAttachment,
  fhirResource,
  healthSource,
  summaryEvidence,
  userSummary,
} from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import type { Db } from "@/lib/db/types";
import { chatScopeSchema, summaryContentSchema, workerEventSchema, type ChatScope, type SummaryContent, type WorkerEvent } from "./contracts";
import { chatRecordsKey } from "./key";
import { CHAT_MAX_TOOL_CALLS } from "./tools";

const DEFAULT_TITLE = "Health chat";
const MAX_EVENT_BYTES = 32_000;
const MAX_RUN_CONTEXT_MESSAGES = 20;
const MAX_RUN_CONTEXT_CHARS = 32_000;

type ConversationScope = ChatScope & { conversationId: string };
type RunScope = ConversationScope & { runId: string };

export type ReadReceipt = { kind: "record" | "note"; targetId: string; version: string };
function requestDigest(keys: UserKeys, value: unknown): string { return createHmac("sha256", keys.macKey).update(canonicalJson(value)).digest("hex"); }

const field = (table: string, name: string, rowId: string) => ({ table, field: name, rowId });

function encrypted(keys: UserKeys, table: string, name: string, rowId: string, value: unknown): string {
  return sealField(keys, JSON.stringify(value), field(table, name, rowId));
}

function decrypted<T>(keys: UserKeys, table: string, name: string, rowId: string, value: string): T {
  return JSON.parse(unsealField(keys, value, field(table, name, rowId))) as T;
}

async function keysFor(tx: Db, userId: string, now: Date): Promise<UserKeys> {
  return userKeysFor(tx, chatRecordsKey(), userId, now);
}

function requireConversationScope(scope: ChatScope): ConversationScope {
  const parsed = chatScopeSchema.parse(scope);
  if (!parsed.conversationId) throw new Error("A chat conversation scope is required");
  return parsed as ConversationScope;
}

function requireRunScope(scope: ChatScope): RunScope {
  const conversation = requireConversationScope(scope);
  if (!conversation.runId) throw new Error("A chat run scope is required");
  return conversation as RunScope;
}

function requireWorkerScope(scope: ChatScope): RunScope & { runAttempt: number; workerId: string } {
  const run = requireRunScope(scope);
  if (!run.runAttempt || !run.workerId) throw new Error("A fenced worker scope is required");
  return run as RunScope & { runAttempt: number; workerId: string };
}

async function ownedConversation(tx: Db, scope: ConversationScope) {
  const [row] = await tx
    .select({ id: chatConversation.id })
    .from(chatConversation)
    .where(and(eq(chatConversation.id, scope.conversationId), eq(chatConversation.userId, scope.userId)))
    .limit(1);
  if (!row) throw new Error("Chat conversation was not found");
  return row;
}

async function ownedRun(tx: Db, scope: RunScope) {
  const [row] = await tx
    .select()
    .from(chatRun)
    .where(and(eq(chatRun.id, scope.runId), eq(chatRun.conversationId, scope.conversationId), eq(chatRun.userId, scope.userId)))
    .limit(1)
    .for("update");
  if (!row) throw new Error("Chat run was not found");
  return row;
}

export type ConversationView = { id: string; title: string; archivedAt: Date | null; createdAt: Date; updatedAt: Date };
export type MessageView = { id: string; sequence: number; role: "user" | "assistant"; status: string; content: string; createdAt: Date; completedAt: Date | null };
export type RunView = {
  id: string;
  conversationId: string;
  parentMessageId: string;
  assistantMessageId: string | null;
  status: string;
  attempt: number;
  cancellationRequestedAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};
export type StoredEvent = { id: string; sequence: number; type: string; data: Record<string, unknown>; createdAt: Date };
export type SummaryView = { id: string; title: string; content: SummaryContent; freshness: "fresh" | "stale"; createdAt: Date; updatedAt: Date };

// The public API maps this stable code to HTTP 409. Keeping it structured lets callers
// distinguish a normal second-tab submission from malformed input without exposing run data.
export class ChatRunBusyError extends Error {
  readonly code = "CHAT_RUN_BUSY";

  constructor() {
    super("A chat response is already in progress for this conversation");
    this.name = "ChatRunBusyError";
  }
}

export function summaryCoverageAsOf(sources: ReadonlyArray<{ lastSyncedAt: Date | null }>): Date | null {
  if (!sources.length || !sources.every((source) => source.lastSyncedAt)) return null;
  return sources.reduce((oldest, source) => (source.lastSyncedAt! < oldest ? source.lastSyncedAt! : oldest), sources[0].lastSyncedAt!);
}

export async function listConversations(db: Db, scope: ChatScope): Promise<ConversationView[]> {
  const parsed = chatScopeSchema.parse(scope);
  return asUser(db, parsed.userId, async (tx) => {
    const keys = await keysFor(tx, parsed.userId, new Date());
    const rows = await tx
      .select()
      .from(chatConversation)
      .where(eq(chatConversation.userId, parsed.userId))
      .orderBy(chatConversation.updatedAt);
    return rows.map((row) => ({
      id: row.id,
      title: row.sealedTitle ? decrypted<string>(keys, "chat_conversation", "title", row.id, row.sealedTitle) : DEFAULT_TITLE,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  });
}

export async function createConversation(db: Db, scope: ChatScope, input: { title?: string; now?: Date } = {}): Promise<ConversationView> {
  const parsed = chatScopeSchema.parse(scope);
  const now = input.now ?? new Date();
  const title = input.title?.trim() || DEFAULT_TITLE;
  if (title.length > 200) throw new Error("Chat title is too long");
  return asUser(db, parsed.userId, async (tx) => {
    const id = randomUUID();
    const keys = await keysFor(tx, parsed.userId, now);
    const [row] = await tx
      .insert(chatConversation)
      .values({ id, userId: parsed.userId, sealedTitle: encrypted(keys, "chat_conversation", "title", id, title), createdAt: now, updatedAt: now })
      .returning();
    return { id: row.id, title, archivedAt: row.archivedAt, createdAt: row.createdAt, updatedAt: row.updatedAt };
  });
}

export async function getConversation(db: Db, scope: ChatScope): Promise<ConversationView | undefined> {
  const parsed = requireConversationScope(scope);
  return asUser(db, parsed.userId, async (tx) => {
    const keys = await keysFor(tx, parsed.userId, new Date());
    const [row] = await tx
      .select()
      .from(chatConversation)
      .where(and(eq(chatConversation.id, parsed.conversationId), eq(chatConversation.userId, parsed.userId)))
      .limit(1);
    return row
      ? {
          id: row.id,
          title: row.sealedTitle ? decrypted<string>(keys, "chat_conversation", "title", row.id, row.sealedTitle) : DEFAULT_TITLE,
          archivedAt: row.archivedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      : undefined;
  });
}

export async function deleteConversation(db: Db, scope: ChatScope): Promise<boolean> {
  const parsed = requireConversationScope(scope);
  return asUser(db, parsed.userId, async (tx) => {
    const deleted = await tx
      .delete(chatConversation)
      .where(and(eq(chatConversation.id, parsed.conversationId), eq(chatConversation.userId, parsed.userId)))
      .returning({ id: chatConversation.id });
    return deleted.length === 1;
  });
}

async function addMessage(
  tx: Db,
  keys: UserKeys,
  scope: ConversationScope,
  input: { role: "user" | "assistant"; status: "pending" | "completed" | "failed" | "cancelled"; content: string; now: Date },
): Promise<typeof chatMessage.$inferSelect> {
  if (input.content.length > 100_000) throw new Error("Chat message is too long");
  const [conversation] = await tx
    .update(chatConversation)
    .set({ nextMessageSequence: sql`${chatConversation.nextMessageSequence} + 1`, updatedAt: input.now })
    .where(and(eq(chatConversation.id, scope.conversationId), eq(chatConversation.userId, scope.userId)))
    .returning({ sequence: chatConversation.nextMessageSequence });
  if (!conversation) throw new Error("Chat conversation was not found");
  const id = randomUUID();
  const [message] = await tx
    .insert(chatMessage)
    .values({
      id,
      userId: scope.userId,
      conversationId: scope.conversationId,
      sequence: conversation.sequence,
      role: input.role,
      status: input.status,
      sealedContent: encrypted(keys, "chat_message", "content", id, input.content),
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: input.status === "completed" ? input.now : null,
    })
    .returning();
  return message;
}

export async function createUserMessage(
  db: Db,
  scope: ChatScope,
  input: { content: string; now?: Date },
): Promise<MessageView> {
  const parsed = requireConversationScope(scope);
  const now = input.now ?? new Date();
  return asUser(db, parsed.userId, async (tx) => {
    const keys = await keysFor(tx, parsed.userId, now);
    const message = await addMessage(tx, keys, parsed, { role: "user", status: "completed", content: input.content, now });
    return { id: message.id, sequence: message.sequence, role: "user", status: message.status, content: input.content, createdAt: message.createdAt, completedAt: message.completedAt };
  });
}

export async function listMessages(db: Db, scope: ChatScope): Promise<MessageView[]> {
  const parsed = requireConversationScope(scope);
  return asUser(db, parsed.userId, async (tx) => {
    await ownedConversation(tx, parsed);
    const keys = await keysFor(tx, parsed.userId, new Date());
    const rows = await tx
      .select()
      .from(chatMessage)
      .where(and(eq(chatMessage.userId, parsed.userId), eq(chatMessage.conversationId, parsed.conversationId)))
      .orderBy(asc(chatMessage.sequence));
    return rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      role: row.role as "user" | "assistant",
      status: row.status,
      content: decrypted<string>(keys, "chat_message", "content", row.id, row.sealedContent),
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    }));
  });
}

export async function createRun(
  db: Db,
  scope: ChatScope,
  input: { parentMessageId: string; idempotencyKey: string; executionMeta?: Record<string, number | string | boolean | null>; initiatingSessionId?: string; now?: Date },
): Promise<RunView> {
  const parsed = requireConversationScope(scope);
  const now = input.now ?? new Date();
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error("Run idempotency key is invalid");
  return asUser(db, parsed.userId, async (tx) => {
    await ownedConversation(tx, parsed);
    const [prior] = await tx
      .select()
      .from(chatRun)
      .where(and(eq(chatRun.userId, parsed.userId), eq(chatRun.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (prior) {
      if (prior.conversationId !== parsed.conversationId || prior.parentMessageId !== input.parentMessageId) throw new Error("Run idempotency key was reused");
      return viewRun(prior);
    }
    const [parent] = await tx
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.id, input.parentMessageId),
          eq(chatMessage.userId, parsed.userId),
          eq(chatMessage.conversationId, parsed.conversationId),
          eq(chatMessage.role, "user"),
        ),
      )
      .limit(1);
    if (!parent) throw new Error("Parent message was not found");
    const [run] = await tx
      .insert(chatRun)
      .values({
        id: randomUUID(),
        userId: parsed.userId,
        conversationId: parsed.conversationId,
        parentMessageId: parent.id,
        idempotencyKey: input.idempotencyKey,
        executionMeta: input.executionMeta ?? {},
        initiatingSessionId: input.initiatingSessionId ?? null,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now,
      })
      .returning();
    return viewRun(run);
  });
}

// Creates the user turn and durable work item as a single transaction. The idempotency key is
// checked after taking the conversation row lock, so a duplicate POST never leaves an orphaned
// message and cannot silently attach a different question to an existing run.
export async function submitQuestionAndRun(
  db: Db,
  scope: ChatScope,
  input: { message: string; idempotencyKey: string; executionMeta?: Record<string, number | string | boolean | null>; initiatingSessionId?: string; now?: Date },
): Promise<{ run: RunView; message: MessageView; duplicate: boolean }> {
  const parsed = requireConversationScope(scope);
  const now = input.now ?? new Date();
  if (!input.message.trim() || input.message.length > 100_000) throw new Error("Chat message is invalid");
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error("Run idempotency key is invalid");
  return asUser(db, parsed.userId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${parsed.userId}))`);
    const [conversation] = await tx
      .select({ id: chatConversation.id })
      .from(chatConversation)
      .where(and(eq(chatConversation.id, parsed.conversationId), eq(chatConversation.userId, parsed.userId)))
      .limit(1)
      .for("update");
    if (!conversation) throw new Error("Chat conversation was not found");
    const keys = await keysFor(tx, parsed.userId, now);
    const [prior] = await tx
      .select()
      .from(chatRun)
      .where(and(eq(chatRun.userId, parsed.userId), eq(chatRun.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (prior) {
      if (prior.conversationId !== parsed.conversationId) throw new Error("Run idempotency key was reused");
      const [parent] = await tx
        .select()
        .from(chatMessage)
        .where(and(eq(chatMessage.id, prior.parentMessageId), eq(chatMessage.userId, parsed.userId), eq(chatMessage.conversationId, parsed.conversationId)))
        .limit(1);
      if (!parent || parent.role !== "user" || decrypted<string>(keys, "chat_message", "content", parent.id, parent.sealedContent) !== input.message) {
        throw new Error("Run idempotency key was reused");
      }
      return {
        run: viewRun(prior),
        message: {
          id: parent.id,
          sequence: parent.sequence,
          role: "user",
          status: parent.status,
          content: input.message,
          createdAt: parent.createdAt,
          completedAt: parent.completedAt,
        },
        duplicate: true,
      };
    }
    // The conversation row lock serializes submissions. Check after the exact idempotency
    // replay so a retry remains safe while a different second-tab question is rejected
    // before it can create an orphaned or out-of-context message.
    const [active] = await tx
      .select({ id: chatRun.id })
      .from(chatRun)
      .where(
        and(
          eq(chatRun.userId, parsed.userId),
          eq(chatRun.conversationId, parsed.conversationId),
          inArray(chatRun.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (active) throw new ChatRunBusyError();
    const queued = await tx.select({ id: chatRun.id }).from(chatRun).where(and(eq(chatRun.userId, parsed.userId), inArray(chatRun.status, ["queued", "running"]))).limit(3);
    if (input.initiatingSessionId && queued.length >= 3) throw new ChatRunBusyError();
    const parent = await addMessage(tx, keys, parsed, { role: "user", status: "completed", content: input.message, now });
    const [run] = await tx
      .insert(chatRun)
      .values({
        id: randomUUID(),
        userId: parsed.userId,
        conversationId: parsed.conversationId,
        parentMessageId: parent.id,
        idempotencyKey: input.idempotencyKey,
        executionMeta: input.executionMeta ?? {},
        initiatingSessionId: input.initiatingSessionId ?? null,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now,
      })
      .returning();
    return {
      run: viewRun(run),
      message: { id: parent.id, sequence: parent.sequence, role: "user", status: parent.status, content: input.message, createdAt: parent.createdAt, completedAt: parent.completedAt },
      duplicate: false,
    };
  });
}

function viewRun(row: typeof chatRun.$inferSelect): RunView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    parentMessageId: row.parentMessageId,
    assistantMessageId: row.assistantMessageId,
    status: row.status,
    attempt: row.attempt,
    cancellationRequestedAt: row.cancellationRequestedAt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export async function listRuns(db: Db, scope: ChatScope): Promise<RunView[]> {
  const parsed = requireConversationScope(scope);
  return asUser(db, parsed.userId, async (tx) => {
    await ownedConversation(tx, parsed);
    const rows = await tx
      .select()
      .from(chatRun)
      .where(and(eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId)))
      .orderBy(asc(chatRun.createdAt));
    return rows.map(viewRun);
  });
}

export async function findRunForUser(db: Db, scope: ChatScope, runId: string): Promise<RunView | undefined> {
  const parsed = chatScopeSchema.parse(scope);
  return asUser(db, parsed.userId, async (tx) => {
    const [row] = await tx.select().from(chatRun).where(and(eq(chatRun.id, runId), eq(chatRun.userId, parsed.userId))).limit(1);
    return row ? viewRun(row) : undefined;
  });
}

// Context is reconstructed from durable encrypted messages, never from mutable worker state.
// It includes the latest bounded history through the run's parent message, so retries see the
// same conversation prefix without exposing later turns from another run.
export async function loadRunContext(db: Db, scope: ChatScope): Promise<{ run: RunView; parentMessage: MessageView; messages: MessageView[] }> {
  const parsed = requireWorkerScope(scope);
  return asUser(db, parsed.userId, async (tx) => {
    const run = await ownedRun(tx, parsed);
    if (run.attempt !== parsed.runAttempt || run.leaseOwner !== parsed.workerId || run.status !== "running" || !run.leaseExpiresAt || run.leaseExpiresAt <= new Date()) {
      throw new Error("Chat worker lease is no longer active");
    }
    const [message] = await tx.select().from(chatMessage).where(and(eq(chatMessage.id, run.parentMessageId), eq(chatMessage.userId, parsed.userId), eq(chatMessage.conversationId, parsed.conversationId))).limit(1);
    if (!message) throw new Error("Run parent message was not found");
    const keys = await keysFor(tx, parsed.userId, new Date());
    const history = await tx
      .select()
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.userId, parsed.userId),
          eq(chatMessage.conversationId, parsed.conversationId),
          eq(chatMessage.status, "completed"),
          lte(chatMessage.sequence, message.sequence),
        ),
      )
      .orderBy(desc(chatMessage.sequence))
      .limit(MAX_RUN_CONTEXT_MESSAGES);
    let remaining = MAX_RUN_CONTEXT_CHARS;
    const messages: MessageView[] = [];
    for (const row of history) {
      const content = decrypted<string>(keys, "chat_message", "content", row.id, row.sealedContent);
      if (remaining <= 0) break;
      const bounded = content.slice(0, remaining);
      remaining -= bounded.length;
      messages.unshift({ id: row.id, sequence: row.sequence, role: row.role as "user" | "assistant", status: row.status, content: bounded, createdAt: row.createdAt, completedAt: row.completedAt });
    }
    const parentMessage = messages.find((candidate) => candidate.id === message.id);
    if (!parentMessage) throw new Error("Run parent message exceeds context budget");
    return {
      run: viewRun(run),
      parentMessage,
      messages,
    };
  });
}

export async function claimRun(db: Db, scope: ChatScope, input: { workerId: string; leaseMs: number; now?: Date }): Promise<RunView | undefined> {
  const parsed = requireRunScope(scope);
  const now = input.now ?? new Date();
  if (!input.workerId || input.workerId.length > 200 || input.leaseMs < 1_000 || input.leaseMs > 10 * 60_000) throw new Error("Invalid run lease");
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
  return asUser(db, parsed.userId, async (tx) => {
    const [run] = await tx
      .update(chatRun)
      .set({
        status: "running",
        leaseOwner: input.workerId,
        leaseExpiresAt,
        startedAt: now,
        attempt: sql`${chatRun.attempt} + 1`,
        nextWorkerSequence: 0,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatRun.id, parsed.runId),
          eq(chatRun.userId, parsed.userId),
          eq(chatRun.conversationId, parsed.conversationId),
          eq(chatRun.status, "queued"),
          lte(chatRun.nextAttemptAt, now),
          or(isNull(chatRun.leaseExpiresAt), sql`${chatRun.leaseExpiresAt} <= ${now}`),
        ),
      )
      .returning();
    return run ? viewRun(run) : undefined;
  });
}

export async function renewLease(db: Db, scope: ChatScope, input: { leaseMs: number; now?: Date }): Promise<boolean> {
  const parsed = requireWorkerScope(scope);
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
  return asUser(db, parsed.userId, async (tx) => {
    const updated = await tx
      .update(chatRun)
      .set({ leaseExpiresAt, updatedAt: now })
      .where(
        and(
          eq(chatRun.id, parsed.runId),
          eq(chatRun.userId, parsed.userId),
          eq(chatRun.conversationId, parsed.conversationId),
          eq(chatRun.status, "running"),
          eq(chatRun.leaseOwner, parsed.workerId),
          eq(chatRun.attempt, parsed.runAttempt),
          gt(chatRun.leaseExpiresAt, now),
        ),
      )
      .returning({ id: chatRun.id });
    return updated.length === 1;
  });
}

export async function requestRunCancellation(db: Db, scope: ChatScope, now = new Date()): Promise<boolean> {
  const parsed = requireRunScope(scope);
  return asUser(db, parsed.userId, async (tx) => {
    const [run] = await tx
      .select({ status: chatRun.status })
      .from(chatRun)
      .where(and(eq(chatRun.id, parsed.runId), eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId)))
      .limit(1)
      .for("update");
    if (!run || (run.status !== "queued" && run.status !== "running")) return false;
    const updated = await tx
      .update(chatRun)
      .set(
        run.status === "queued"
          ? { status: "cancelled", cancellationRequestedAt: now, completedAt: now, updatedAt: now }
          : { cancellationRequestedAt: now, updatedAt: now },
      )
      .where(and(eq(chatRun.id, parsed.runId), eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId), eq(chatRun.status, run.status)))
      .returning({ id: chatRun.id });
    return updated.length === 1;
  });
}

export async function isCancellationRequested(db: Db, scope: ChatScope): Promise<boolean> {
  const parsed = requireWorkerScope(scope);
  return asUser(db, parsed.userId, async (tx) => {
    const [run] = await tx
      .select({ cancellationRequestedAt: chatRun.cancellationRequestedAt, attempt: chatRun.attempt, leaseOwner: chatRun.leaseOwner, leaseExpiresAt: chatRun.leaseExpiresAt })
      .from(chatRun)
      .where(and(eq(chatRun.id, parsed.runId), eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId)))
      .limit(1);
    return !!run && run.attempt === parsed.runAttempt && run.leaseOwner === parsed.workerId && !!run.leaseExpiresAt && run.leaseExpiresAt > new Date() && !!run.cancellationRequestedAt;
  });
}

// The gateway calls this before every data-bearing tool. It is separate from the broker's
// signature check so a stale worker cannot use an otherwise valid, older capability after a
// lease changes hands.
export async function assertActiveWorker(db: Db, scope: ChatScope, now = new Date()): Promise<void> {
  const parsed = requireWorkerScope(scope);
  const active = await asUser(db, parsed.userId, async (tx) => {
    const [run] = await tx
      .select({ id: chatRun.id })
      .from(chatRun)
      .where(
        and(
          eq(chatRun.id, parsed.runId),
          eq(chatRun.userId, parsed.userId),
          eq(chatRun.conversationId, parsed.conversationId),
          eq(chatRun.status, "running"),
          eq(chatRun.attempt, parsed.runAttempt),
          eq(chatRun.leaseOwner, parsed.workerId),
          gt(chatRun.leaseExpiresAt, now),
        ),
      )
      .limit(1);
    return !!run;
  });
  if (!active) throw new Error("Chat worker lease is no longer active");
}

export async function appendWorkerEvent(
  db: Db,
  scope: ChatScope,
  input: WorkerEvent,
  now = new Date(),
): Promise<{ status: "appended" | "duplicate" | "out_of_order" }> {
  const parsed = requireWorkerScope(scope);
  const event = workerEventSchema.parse(input);
  const encoded = JSON.stringify(event.data);
  if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT_BYTES) throw new Error("Chat event payload is too large");
  return asUser(db, parsed.userId, async (tx) => {
    const run = await ownedRun(tx, parsed);
    const keys = await keysFor(tx, parsed.userId, now);
    const digest = requestDigest(keys, event);
    const [existing] = await tx
      .select({ id: chatEvent.id, requestDigest: chatEvent.requestDigest })
      .from(chatEvent)
      .where(and(eq(chatEvent.runId, parsed.runId), eq(chatEvent.attempt, parsed.runAttempt), eq(chatEvent.eventId, event.eventId), eq(chatEvent.userId, parsed.userId)))
      .limit(1);
    if (existing) {
      if (existing.requestDigest !== digest) throw new Error("Worker event id was reused");
      return { status: "duplicate" as const };
    }

    if (!run || run.status !== "running" || run.attempt !== parsed.runAttempt || run.leaseOwner !== parsed.workerId || !run.leaseExpiresAt || run.leaseExpiresAt <= now || run.nextWorkerSequence !== event.sequence - 1) {
      return { status: "out_of_order" as const };
    }
    await tx.update(chatRun).set({ nextEventSequence: run.nextEventSequence + 1, nextWorkerSequence: event.sequence, updatedAt: now }).where(eq(chatRun.id, run.id));
    const id = randomUUID();
    await tx.insert(chatEvent).values({
      id,
      userId: parsed.userId,
      conversationId: parsed.conversationId,
      runId: parsed.runId,
      eventId: event.eventId,
      attempt: parsed.runAttempt,
      workerSequence: event.sequence,
      sequence: run.nextEventSequence + 1,
      kind: event.type,
      requestDigest: digest,
      sealedPayload: encrypted(keys, "chat_event", "payload", id, event.data),
      createdAt: now,
    });
    return { status: "appended" as const };
  });
}

// The trusted service coordinator emits lifecycle events for its own actions (for example,
// dispatch rejection or cancellation). It shares the worker's active lease fence but gets a
// server-assigned global sequence and a negative source sequence, leaving positive source
// sequences exclusively for the worker protocol.
export async function appendServiceEvent(
  db: Db,
  scope: ChatScope,
  input: { eventId: string; type: WorkerEvent["type"]; data: Record<string, unknown> },
  now = new Date(),
): Promise<{ status: "appended" | "duplicate" | "inactive"; sequence?: number }> {
  const parsed = requireWorkerScope(scope);
  const event = workerEventSchema.omit({ sequence: true }).parse(input);
  const encoded = JSON.stringify(event.data);
  if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT_BYTES) throw new Error("Chat event payload is too large");
  return asUser(db, parsed.userId, async (tx) => {
    const [existing] = await tx
      .select({ sequence: chatEvent.sequence })
      .from(chatEvent)
      .where(and(eq(chatEvent.runId, parsed.runId), eq(chatEvent.attempt, parsed.runAttempt), eq(chatEvent.eventId, event.eventId), eq(chatEvent.userId, parsed.userId)))
      .limit(1);
    if (existing) return { status: "duplicate" as const, sequence: existing.sequence };
    const [run] = await tx
      .select()
      .from(chatRun)
      .where(and(eq(chatRun.id, parsed.runId), eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId)))
      .limit(1)
      .for("update");
    if (!run || run.status !== "running" || run.attempt !== parsed.runAttempt || run.leaseOwner !== parsed.workerId || !run.leaseExpiresAt || run.leaseExpiresAt <= now) {
      return { status: "inactive" as const };
    }
    const sequence = run.nextEventSequence + 1;
    const id = randomUUID();
    const keys = await keysFor(tx, parsed.userId, now);
    await tx.update(chatRun).set({ nextEventSequence: sequence, updatedAt: now }).where(eq(chatRun.id, run.id));
    await tx.insert(chatEvent).values({
      id,
      userId: parsed.userId,
      conversationId: parsed.conversationId,
      runId: parsed.runId,
      eventId: event.eventId,
      attempt: parsed.runAttempt,
      workerSequence: -sequence,
      sequence,
      kind: event.type,
      sealedPayload: encrypted(keys, "chat_event", "payload", id, event.data),
      createdAt: now,
    });
    return { status: "appended" as const, sequence };
  });
}

// Atomically persist a terminal worker event and its run/message transition. This protects
// replay clients from observing a completed event whose answer was lost if a lease is fenced or
// the final update fails. Non-terminal worker events continue to use appendWorkerEvent.
export async function finalizeWorkerEvent(
  db: Db,
  scope: ChatScope,
  input: {
    event: WorkerEvent;
    status: "completed" | "failed" | "cancelled";
    assistantContent?: string;
    now?: Date;
  },
): Promise<RunView> {
  const parsed = requireWorkerScope(scope);
  const now = input.now ?? new Date();
  if (input.assistantContent !== undefined && input.assistantContent.length > 100_000) throw new Error("Chat message is too long");
  return asUser(db, parsed.userId, async (tx) => {
    const appended = await appendWorkerEvent(tx, parsed, input.event, now);
    if (appended.status === "out_of_order") throw new Error("Chat worker event is out of order");
    if (appended.status === "duplicate") {
      const [alreadyFinished] = await tx
        .select()
        .from(chatRun)
        .where(and(eq(chatRun.id, parsed.runId), eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId)))
        .limit(1);
      if (alreadyFinished?.status === input.status) return viewRun(alreadyFinished);
      throw new Error("Duplicate terminal event does not match run state");
    }
    const finished = await finishRun(tx, parsed, { status: input.status, assistantContent: input.assistantContent, now });
    if (!finished) throw new Error("Chat worker lease is no longer active");
    return finished;
  });
}

// The dispatcher uses the same transaction rule for broker-originated terminal states. A failed
// Iggy launch or confirmed cancellation therefore cannot leave a replayed terminal event without
// the matching durable run state.
export async function finalizeServiceEvent(
  db: Db,
  scope: ChatScope,
  input: {
    event: { eventId: string; type: WorkerEvent["type"]; data: Record<string, unknown> };
    status: "failed" | "cancelled";
    now?: Date;
  },
): Promise<RunView> {
  const parsed = requireWorkerScope(scope);
  const now = input.now ?? new Date();
  return asUser(db, parsed.userId, async (tx) => {
    const appended = await appendServiceEvent(tx, parsed, input.event, now);
    if (appended.status === "inactive") throw new Error("Chat worker lease is no longer active");
    if (appended.status === "duplicate") {
      const [alreadyFinished] = await tx
        .select()
        .from(chatRun)
        .where(and(eq(chatRun.id, parsed.runId), eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId)))
        .limit(1);
      if (alreadyFinished?.status === input.status) return viewRun(alreadyFinished);
      throw new Error("Duplicate terminal service event does not match run state");
    }
    const finished = await finishRun(tx, parsed, { status: input.status, now });
    if (!finished) throw new Error("Chat worker lease is no longer active");
    return finished;
  });
}

export async function listEventsAfter(db: Db, scope: ChatScope, sequence = 0): Promise<StoredEvent[]> {
  const parsed = requireRunScope(scope);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error("Event sequence is invalid");
  return asUser(db, parsed.userId, async (tx) => {
    await ownedRun(tx, parsed);
    const keys = await keysFor(tx, parsed.userId, new Date());
    const rows = await tx
      .select()
      .from(chatEvent)
      .where(and(eq(chatEvent.userId, parsed.userId), eq(chatEvent.runId, parsed.runId), gt(chatEvent.sequence, sequence)))
      .orderBy(asc(chatEvent.sequence));
    return rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      type: row.kind,
      data: decrypted<Record<string, unknown>>(keys, "chat_event", "payload", row.id, row.sealedPayload),
      createdAt: row.createdAt,
    }));
  });
}

export async function finishRun(
  db: Db,
  scope: ChatScope,
  input: { status: "completed" | "failed" | "cancelled"; assistantContent?: string; now?: Date },
): Promise<RunView | undefined> {
  const parsed = requireWorkerScope(scope);
  const now = input.now ?? new Date();
  return asUser(db, parsed.userId, async (tx) => {
    const [run] = await tx
      .select()
      .from(chatRun)
      .where(and(eq(chatRun.id, parsed.runId), eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId)))
      .limit(1)
      .for("update");
    if (
      !run ||
      run.status !== "running" ||
      run.leaseOwner !== parsed.workerId ||
      run.attempt !== parsed.runAttempt ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= now ||
      (run.cancellationRequestedAt !== null && input.status === "completed")
    ) {
      return undefined;
    }
    const keys = await keysFor(tx, parsed.userId, now);
    let assistantMessageId = run.assistantMessageId;
    if (input.assistantContent !== undefined) {
      const message = await addMessage(tx, keys, parsed, { role: "assistant", status: input.status === "completed" ? "completed" : input.status, content: input.assistantContent, now });
      assistantMessageId = message.id;
    }
    const [finished] = await tx
      .update(chatRun)
      .set({ status: input.status, assistantMessageId, completedAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(chatRun.id, parsed.runId), eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId), eq(chatRun.leaseOwner, parsed.workerId), eq(chatRun.attempt, parsed.runAttempt)))
      .returning();
    return finished ? viewRun(finished) : undefined;
  });
}

async function refreshSummaryFreshness(tx: Db, keys: UserKeys, userId: string, rows: (typeof userSummary.$inferSelect)[]): Promise<string[]> {
  if (!rows.length) return [];
    const evidence = await tx.select().from(summaryEvidence).where(and(eq(summaryEvidence.userId, userId), inArray(summaryEvidence.summaryId, rows.map(row => row.id))));
    const noteIds = evidence.flatMap(row => row.attachmentId ? [row.attachmentId] : []);
    const notes = noteIds.length ? await tx.select({ id: fhirAttachment.id, resourceId: fhirAttachment.resourceId, sealedText: fhirAttachment.sealedText }).from(fhirAttachment).where(and(eq(fhirAttachment.userId, userId), inArray(fhirAttachment.id, noteIds))) : [];
    const recordIds = [...evidence.flatMap(row => row.recordId ? [row.recordId] : []), ...notes.map(note => note.resourceId)];
    const records = recordIds.length ? await tx.select({ id: fhirResource.id, version: fhirResource.contentHmac }).from(fhirResource).where(and(eq(fhirResource.userId, userId), inArray(fhirResource.id, recordIds), isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt))) : [];
    const recordVersions = new Map(records.map(row => [row.id, row.version]));
    const noteVersions = new Map(notes.filter(note => note.sealedText && recordVersions.has(note.resourceId)).map(note => [note.id, noteReadVersion(keys, note.sealedText!)]));
    const stale = rows.filter(row => {
      const supported = evidence.filter(item => item.summaryId === row.id);
      if (!supported.length) return !!row.originatingRunId;
      return supported.some(item => {
        const reference = decrypted<{ version?: string }>(keys, "summary_evidence", "reference", item.id, item.sealedReference);
        const current = item.kind === "record" ? item.recordId && recordVersions.get(item.recordId) : item.attachmentId && noteVersions.get(item.attachmentId);
        return !current || (reference.version !== undefined && reference.version !== current);
      });
    }).map(row => row.id);
    if (stale.length) await tx.update(userSummary).set({ freshness: "stale", updatedAt: new Date() }).where(and(eq(userSummary.userId, userId), inArray(userSummary.id, stale)));
  return stale;
}

export async function listSummaries(db: Db, scope: ChatScope, recallOnly = false): Promise<SummaryView[]> {
  const parsed = chatScopeSchema.parse(scope);
  return asUser(db, parsed.userId, async (tx) => {
    const keys = await keysFor(tx, parsed.userId, new Date());
    const rows = await tx.select().from(userSummary)
      .where(and(eq(userSummary.userId, parsed.userId), isNull(userSummary.deletedAt), ...(recallOnly ? [eq(userSummary.freshness, "fresh"), sql`exists (select 1 from ${chatRun} where ${chatRun.id} = ${userSummary.originatingRunId} and ${chatRun.userId} = ${parsed.userId} and ${chatRun.status} = 'completed')`] : [])))
      .orderBy(desc(userSummary.updatedAt)).limit(recallOnly ? 10 : 100);
    if (!rows.length) return [];
    const stale = await refreshSummaryFreshness(tx, keys, parsed.userId, rows);
    return rows.filter(row => !recallOnly || !stale.includes(row.id)).map(row => ({
      id: row.id, title: decrypted<string>(keys, "user_summary", "title", row.id, row.sealedTitle),
      content: summaryContentSchema.parse(decrypted<unknown>(keys, "user_summary", "content", row.id, row.sealedContent)),
      freshness: stale.includes(row.id) ? "stale" : row.freshness as "fresh" | "stale", createdAt: row.createdAt, updatedAt: row.updatedAt,
    }));
  });
}

export async function deleteSummary(db: Db, scope: ChatScope, summaryId: string): Promise<boolean> {
  const parsed = chatScopeSchema.parse(scope);
  return asUser(db, parsed.userId, async (tx) => {
    const deleted = await tx
      .update(userSummary)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(userSummary.id, summaryId), eq(userSummary.userId, parsed.userId), isNull(userSummary.deletedAt)))
      .returning({ id: userSummary.id });
    return deleted.length === 1;
  });
}

export async function saveSummary(
  db: Db,
  scope: ChatScope,
  input: {
    idempotencyKey: string;
    title: string;
    text: string;
    coverageState: SummaryContent["coverage"]["state"];
    evidence: { kind: "record" | "note"; targetId: string }[];
    now?: Date;
  },
): Promise<SummaryView> {
  const parsed = chatScopeSchema.parse(scope);
  const now = input.now ?? new Date();
  if (!input.idempotencyKey || input.idempotencyKey.length > 200 || input.title.trim().length === 0 || input.title.length > 500) throw new Error("Summary input is invalid");
  if (input.text.trim().length === 0 || input.text.length > 20_000 || new Set(input.evidence.map((e) => `${e.kind}:${e.targetId}`)).size !== input.evidence.length) {
    throw new Error("Summary evidence is invalid");
  }
  return asUser(db, parsed.userId, async (tx) => {
    let run: typeof chatRun.$inferSelect | undefined;
    if (parsed.runId) {
      run = await ownedRun(tx, requireRunScope(parsed));
      if (!parsed.runAttempt || !parsed.workerId || run.status !== "running" || run.attempt !== parsed.runAttempt || run.leaseOwner !== parsed.workerId || !run.leaseExpiresAt || run.leaseExpiresAt <= now || run.cancellationRequestedAt) throw new Error("Chat worker lease is no longer active");
      if (!input.evidence.length) throw new Error("Summary requires current-run evidence");
    }
    const [existing] = await tx
      .select()
      .from(userSummary)
      .where(and(eq(userSummary.userId, parsed.userId), eq(userSummary.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    const keys = await keysFor(tx, parsed.userId, now);
    if (existing) {
      return {
        id: existing.id,
        title: decrypted<string>(keys, "user_summary", "title", existing.id, existing.sealedTitle),
        content: summaryContentSchema.parse(decrypted<unknown>(keys, "user_summary", "content", existing.id, existing.sealedContent)),
        freshness: existing.freshness as "fresh" | "stale",
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      };
    }
    const summaryId = randomUUID();
    const sourceIds = new Set<string>();
    const versions = new Map<string, string>();
    const receipts: ReadReceipt[] = [];
    if (run) {
      const calls = await tx.select().from(chatToolCall).where(and(eq(chatToolCall.runId, run.id), eq(chatToolCall.userId, parsed.userId), eq(chatToolCall.status, "completed")));
      for (const call of calls) if (call.sealedContext) receipts.push(...(decrypted<{ readEvidence?: ReadReceipt[] }>(keys, "chat_tool_call", "context", call.id, call.sealedContext).readEvidence ?? []));
    }
    for (const evidence of input.evidence) {
      if (evidence.kind === "record") {
        const [record] = await tx.select({ id: fhirResource.id, sourceId: fhirResource.sourceId, version: fhirResource.contentHmac }).from(fhirResource).where(and(eq(fhirResource.id, evidence.targetId), eq(fhirResource.userId, parsed.userId), isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt))).limit(1);
        if (!record) throw new Error("Summary record evidence was not found");
        if (run && !receipts.some(r => r.kind === "record" && r.targetId === record.id && r.version === record.version)) throw new Error("Summary evidence was not read in this run");
        versions.set(`record:${record.id}`, record.version);
        sourceIds.add(record.sourceId);
      } else {
        const [note] = await tx.select({ id: fhirAttachment.id, sourceId: fhirAttachment.sourceId, sealedText: fhirAttachment.sealedText, resourceId: fhirAttachment.resourceId }).from(fhirAttachment).where(and(eq(fhirAttachment.id, evidence.targetId), eq(fhirAttachment.userId, parsed.userId))).limit(1);
        if (!note) throw new Error("Summary note evidence was not found");
        if (run) {
          const [parent] = await tx.select({ id: fhirResource.id }).from(fhirResource).where(and(eq(fhirResource.id, note.resourceId), eq(fhirResource.userId, parsed.userId), isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt))).limit(1);
          if (!parent || !note.sealedText || !receipts.some(r => r.kind === "note" && r.targetId === note.id && r.version === requestDigest(keys, note.sealedText))) throw new Error("Summary note evidence was not read in this run");
        }
        if (note.sealedText) versions.set(`note:${note.id}`, noteReadVersion(keys, note.sealedText));
        sourceIds.add(note.sourceId);
      }
    }
    const sources = sourceIds.size
      ? await tx.select({ id: healthSource.id, lastSyncedAt: healthSource.lastSyncedAt, lastSyncStatus: healthSource.lastSyncStatus }).from(healthSource).where(and(eq(healthSource.userId, parsed.userId), inArray(healthSource.id, [...sourceIds])))
      : [];
    if (sources.length !== sourceIds.size) throw new Error("Summary source evidence was not found");
    const asOf = summaryCoverageAsOf(sources);
    const evidenceRows = input.evidence.map((evidence) => ({ ...evidence, id: randomUUID() }));
    const content = summaryContentSchema.parse({
      version: 1,
      text: input.text.trim(),
      evidence: evidenceRows.map(({ id, kind }) => ({ id, kind })),
      coverage: {
        state: sources.some((source) => source.lastSyncStatus === "partial" || source.lastSyncStatus === "failed") ? "partial" : input.coverageState,
        asOf: asOf?.toISOString() ?? null,
        sourceIds: [...sourceIds],
      },
      provenance: { runId: run?.id ?? null, generatedAt: now.toISOString() },
    });
    await tx.insert(userSummary).values({
      id: summaryId,
      userId: parsed.userId,
      originatingRunId: parsed.runId ?? null,
      idempotencyKey: input.idempotencyKey,
      sealedTitle: encrypted(keys, "user_summary", "title", summaryId, input.title.trim()),
      sealedContent: encrypted(keys, "user_summary", "content", summaryId, content),
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(summaryEvidence).values(
      evidenceRows.map((evidence) => ({
        id: evidence.id,
        userId: parsed.userId,
        summaryId,
        kind: evidence.kind,
        recordId: evidence.kind === "record" ? evidence.targetId : null,
        attachmentId: evidence.kind === "note" ? evidence.targetId : null,
        sealedReference: encrypted(keys, "summary_evidence", "reference", evidence.id, { kind: evidence.kind, targetId: evidence.targetId, version: versions.get(`${evidence.kind}:${evidence.targetId}`) }),
        createdAt: now,
      })),
    );
    return { id: summaryId, title: input.title.trim(), content, freshness: "fresh", createdAt: now, updatedAt: now };
  });
}

export async function markSummariesStaleForRecords(db: Db, scope: ChatScope, recordIds: string[], now = new Date()): Promise<number> {
  const parsed = chatScopeSchema.parse(scope);
  if (recordIds.length === 0) return 0;
  return asUser(db, parsed.userId, async (tx) => {
    const linked = tx
      .select({ one: sql`1` })
      .from(summaryEvidence)
      .where(and(eq(summaryEvidence.summaryId, userSummary.id), eq(summaryEvidence.userId, parsed.userId), inArray(summaryEvidence.recordId, recordIds)));
    const updated = await tx
      .update(userSummary)
      .set({ freshness: "stale", updatedAt: now })
      .where(and(eq(userSummary.userId, parsed.userId), isNull(userSummary.deletedAt), sql`exists (${linked})`))
      .returning({ id: userSummary.id });
    return updated.length;
  });
}

export async function beginToolCall(
  db: Db,
  scope: ChatScope,
  input: { callOrder: number; toolName: string; arguments: unknown; context?: unknown; now?: Date },
): Promise<string> {
  const parsed = requireWorkerScope(scope);
  const now = input.now ?? new Date();
  if (!Number.isInteger(input.callOrder) || input.callOrder < 0 || input.toolName.length === 0 || input.toolName.length > 100) throw new Error("Tool call is invalid");
  return asUser(db, parsed.userId, async (tx) => {
    const run = await ownedRun(tx, parsed);
    if (run.status !== "running" || run.attempt !== parsed.runAttempt || run.leaseOwner !== parsed.workerId || !run.leaseExpiresAt || run.leaseExpiresAt <= now) {
      throw new Error("Chat worker lease is no longer active");
    }
    const id = randomUUID();
    const keys = await keysFor(tx, parsed.userId, now);
    await tx.insert(chatToolCall).values({
      id,
      userId: parsed.userId,
      conversationId: parsed.conversationId,
      runId: parsed.runId,
      callOrder: input.callOrder,
      toolName: input.toolName,
      requestDigest: requestDigest(keys, { tool: input.toolName, arguments: input.arguments }),
      sealedArguments: encrypted(keys, "chat_tool_call", "arguments", id, input.arguments),
      sealedContext: input.context === undefined ? null : encrypted(keys, "chat_tool_call", "context", id, input.context),
      startedAt: now,
    });
    return id;
  });
}

// Starts one durable, fenced tool action from a provider call identifier. The identifier is
// encrypted with the request context, so retries can replay an already-completed result without
// exposing provider metadata in an index. Only six sequential actions may begin for a run.
export async function beginRecordedToolCall(
  db: Db,
  scope: ChatScope,
  input: { providerToolCallId: string; toolName: string; arguments: unknown; now?: Date },
): Promise<{ status: "started"; toolCallId: string } | { status: "replay"; toolCallId: string; result: unknown } | { status: "pending"; toolCallId: string }> {
  const parsed = requireWorkerScope(scope);
  const now = input.now ?? new Date();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.providerToolCallId) || !input.toolName || input.toolName.length > 100) throw new Error("Tool call is invalid");
  return asUser(db, parsed.userId, async (tx) => {
    const [run] = await tx
      .select()
      .from(chatRun)
      .where(and(eq(chatRun.id, parsed.runId), eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId)))
      .limit(1)
      .for("update");
    if (!run || run.status !== "running" || run.attempt !== parsed.runAttempt || run.leaseOwner !== parsed.workerId || !run.leaseExpiresAt || run.leaseExpiresAt <= now) {
      throw new Error("Chat worker lease is no longer active");
    }
    if (run.cancellationRequestedAt) throw new Error("Chat run was cancelled");
    const keys = await keysFor(tx, parsed.userId, now);
    const calls = await tx
      .select()
      .from(chatToolCall)
      .where(and(eq(chatToolCall.runId, parsed.runId), eq(chatToolCall.userId, parsed.userId), eq(chatToolCall.conversationId, parsed.conversationId)))
      .orderBy(asc(chatToolCall.callOrder));
    for (const call of calls) {
      if (!call.sealedContext) continue;
      let context: { providerToolCallId?: unknown };
      try {
        context = decrypted<{ providerToolCallId?: unknown }>(keys, "chat_tool_call", "context", call.id, call.sealedContext);
      } catch {
        continue;
      }
      if (context.providerToolCallId !== input.providerToolCallId) continue;
      const argumentsMatch = canonicalJson(decrypted<unknown>(keys, "chat_tool_call", "arguments", call.id, call.sealedArguments)) === canonicalJson(input.arguments);
      if (call.toolName !== input.toolName || !argumentsMatch || (call.requestDigest && call.requestDigest !== requestDigest(keys, { tool: input.toolName, arguments: input.arguments }))) throw new Error("Provider tool call id was reused");
      if (call.status === "completed" && call.sealedResult) {
        return { status: "replay" as const, toolCallId: call.id, result: decrypted<unknown>(keys, "chat_tool_call", "result", call.id, call.sealedResult) };
      }
      return { status: "pending" as const, toolCallId: call.id };
    }
    if (calls.length >= CHAT_MAX_TOOL_CALLS) throw new Error("Chat tool-call limit reached");
    const id = randomUUID();
    await tx.insert(chatToolCall).values({
      id,
      userId: parsed.userId,
      conversationId: parsed.conversationId,
      runId: parsed.runId,
      callOrder: calls.length,
      toolName: input.toolName,
      requestDigest: requestDigest(keys, { tool: input.toolName, arguments: input.arguments }),
      sealedArguments: encrypted(keys, "chat_tool_call", "arguments", id, input.arguments),
      sealedContext: encrypted(keys, "chat_tool_call", "context", id, { providerToolCallId: input.providerToolCallId }),
      startedAt: now,
    });
    return { status: "started" as const, toolCallId: id };
  });
}

export async function finishToolCall(
  db: Db,
  scope: ChatScope,
  input: { toolCallId: string; status: "completed" | "failed" | "cancelled"; result?: unknown; resultMeta?: Record<string, number | string | boolean | null>; readEvidence?: ReadReceipt[]; now?: Date },
): Promise<boolean> {
  const parsed = requireWorkerScope(scope);
  const now = input.now ?? new Date();
  return asUser(db, parsed.userId, async (tx) => {
    const run = await ownedRun(tx, parsed);
    if (run.status !== "running" || run.attempt !== parsed.runAttempt || run.leaseOwner !== parsed.workerId || !run.leaseExpiresAt || run.leaseExpiresAt <= now) return false;
    const keys = await keysFor(tx, parsed.userId, now);
    const [existing] = await tx.select({ sealedContext: chatToolCall.sealedContext }).from(chatToolCall).where(and(eq(chatToolCall.id, input.toolCallId), eq(chatToolCall.runId, parsed.runId), eq(chatToolCall.userId, parsed.userId))).limit(1);
    const context = existing?.sealedContext ? decrypted<Record<string, unknown>>(keys, "chat_tool_call", "context", input.toolCallId, existing.sealedContext) : {};
    const updated = await tx
      .update(chatToolCall)
      .set({
        status: input.status,
        sealedResult: input.result === undefined ? null : encrypted(keys, "chat_tool_call", "result", input.toolCallId, input.result),
        resultMeta: input.resultMeta ?? {},
        sealedContext: encrypted(keys, "chat_tool_call", "context", input.toolCallId, { ...context, readEvidence: input.readEvidence ?? [] }),
        completedAt: now,
      })
      .where(and(eq(chatToolCall.id, input.toolCallId), eq(chatToolCall.runId, parsed.runId), eq(chatToolCall.conversationId, parsed.conversationId), eq(chatToolCall.userId, parsed.userId)))
      .returning({ id: chatToolCall.id });
    return updated.length === 1;
  });
}

export function noteReadVersion(keys: UserKeys, sealedText: string): string { return requestDigest(keys, sealedText); }

// Browser-only pagination. Worker/legacy helper contracts remain unchanged.
export const CHAT_BROWSER_PAGE_BYTES = 96 * 1024;
export const CHAT_BROWSER_MESSAGE_BYTES = 96 * 1024;
export type PagedMessageView = MessageView & { truncated: boolean };
export class ChatPageCursorError extends Error {
  readonly code = "CHAT_INVALID_CURSOR";
  constructor() { super("Invalid chat page cursor"); this.name = "ChatPageCursorError"; }
}
export class ChatPageSizeError extends Error {
  readonly code = "CHAT_PAGE_TOO_LARGE";
  constructor() { super("Chat page item exceeds display limit"); this.name = "ChatPageSizeError"; }
}
const pageUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pageLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new ChatPageCursorError();
  return value;
}
function encodedBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function validCursor(cursor: string | undefined): void { if (cursor !== undefined && !pageUuid.test(cursor)) throw new ChatPageCursorError(); }
function messageView(keys: UserKeys, row: typeof chatMessage.$inferSelect): PagedMessageView {
  const view: PagedMessageView = {
    id: row.id, sequence: row.sequence, role: row.role as "user" | "assistant", status: row.status,
    content: decrypted<string>(keys, "chat_message", "content", row.id, row.sealedContent),
    createdAt: row.createdAt, completedAt: row.completedAt, truncated: false,
  };
  if (encodedBytes(view) <= CHAT_BROWSER_MESSAGE_BYTES - 2) return view;
  // A legacy row may predate today's input caps. Clip only its display text, and
  // keep the row/sequence in the page so the cursor never skips a message.
  const text = view.content;
  view.truncated = true;
  let low = 0; let high = text.length;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    view.content = text.slice(0, end);
    if (encodedBytes(view) <= CHAT_BROWSER_MESSAGE_BYTES - 2) low = end; else high = end - 1;
  }
  // Preserve Unicode code points at the cut; escaped JSON bytes are counted too.
  if (low > 0 && low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1]) && /[\uDC00-\uDFFF]/.test(text[low])) low -= 1;
  view.content = text.slice(0, low);
  return view;
}

export async function listConversationPage(
  db: Db, scope: ChatScope, input: { cursor?: string; limit?: number } = {},
): Promise<{ conversations: ConversationView[]; hasMore: boolean; nextCursor: string | null }> {
  const parsed = chatScopeSchema.parse(scope); validCursor(input.cursor);
  const limit = pageLimit(input.limit, 32, 64);
  return asUser(db, parsed.userId, async (tx) => {
    let cutoff: { id: string } | undefined;
    if (input.cursor) {
      [cutoff] = await tx.select({ id: chatConversation.id }).from(chatConversation).where(and(eq(chatConversation.userId, parsed.userId), eq(chatConversation.id, input.cursor))).limit(1);
      if (!cutoff) throw new ChatPageCursorError();
    }
    // Compare the stored timestamp in SQL: a JavaScript Date loses PostgreSQL microseconds.
    const conditions = [eq(chatConversation.userId, parsed.userId), ...(cutoff ? [sql`(${chatConversation.createdAt}, ${chatConversation.id}) < (select c.created_at, c.id from ${chatConversation} c where c.id = ${cutoff.id} and c.user_id = ${parsed.userId})`] : [])];
    const rows = await tx.select().from(chatConversation).where(and(...conditions)).orderBy(desc(chatConversation.createdAt), desc(chatConversation.id)).limit(limit);
    const keys = await keysFor(tx, parsed.userId, new Date());
    const conversations = rows.map(row => ({ id: row.id, title: row.sealedTitle ? decrypted<string>(keys, "chat_conversation", "title", row.id, row.sealedTitle) : DEFAULT_TITLE, archivedAt: row.archivedAt, createdAt: row.createdAt, updatedAt: row.updatedAt }));
    const oldest = rows.at(-1);
    const more = oldest && rows.length === limit ? await tx.select({ id: chatConversation.id }).from(chatConversation).where(and(eq(chatConversation.userId, parsed.userId), sql`(${chatConversation.createdAt}, ${chatConversation.id}) < (select c.created_at, c.id from ${chatConversation} c where c.id = ${oldest.id} and c.user_id = ${parsed.userId})`)).limit(1) : [];
    return { conversations, hasMore: more.length > 0, nextCursor: more.length ? oldest!.id : null };
  });
}

export async function listMessagePage(
  db: Db, scope: ChatScope, input: { before?: number; limit?: number } = {},
): Promise<{ messages: PagedMessageView[]; hasMore: boolean; nextBefore: number | null }> {
  const parsed = requireConversationScope(scope);
  const limit = pageLimit(input.limit, 20, 20);
  if (input.before !== undefined && (!Number.isSafeInteger(input.before) || input.before < 1)) throw new ChatPageCursorError();
  return asUser(db, parsed.userId, async (tx) => {
    await ownedConversation(tx, parsed);
    const rows = await tx.select().from(chatMessage).where(and(eq(chatMessage.userId, parsed.userId), eq(chatMessage.conversationId, parsed.conversationId), ...(input.before === undefined ? [] : [lt(chatMessage.sequence, input.before)]))).orderBy(desc(chatMessage.sequence)).limit(limit);
    const keys = await keysFor(tx, parsed.userId, new Date());
    const selected: PagedMessageView[] = []; let bytes = 2;
    for (const row of rows) {
      const view = messageView(keys, row); const size = encodedBytes(view) + (selected.length ? 1 : 0);
      if (bytes + size > CHAT_BROWSER_PAGE_BYTES) break;
      selected.push(view); bytes += size;
    }
    if (rows.length && !selected.length) throw new ChatPageSizeError();
    const oldest = selected.at(-1);
    let hasMore = rows.length > selected.length;
    if (!hasMore && oldest && rows.length === limit) {
      const more = await tx.select({ id: chatMessage.id }).from(chatMessage).where(and(eq(chatMessage.userId, parsed.userId), eq(chatMessage.conversationId, parsed.conversationId), lt(chatMessage.sequence, oldest.sequence))).limit(1);
      hasMore = more.length > 0;
    }
    return { messages: selected.reverse(), hasMore, nextBefore: hasMore ? oldest!.sequence : null };
  });
}

export async function listRunsForMessages(
  db: Db, scope: ChatScope, messageIds: readonly string[], input: { includeActive?: boolean } = {},
): Promise<RunView[]> {
  const parsed = requireConversationScope(scope);
  if (messageIds.length > 20 || messageIds.some(id => !pageUuid.test(id))) throw new ChatPageCursorError();
  const ids = [...new Set(messageIds)];
  return asUser(db, parsed.userId, async (tx) => {
    await ownedConversation(tx, parsed);
    // A legacy parent can have multiple runs; show only the latest matching run
    // for each parent, rather than letting one old message make this unbounded.
    const rows = ids.length ? await tx.selectDistinctOn([chatRun.parentMessageId]).from(chatRun).where(and(eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId), or(inArray(chatRun.parentMessageId, ids), inArray(chatRun.assistantMessageId, ids)))).orderBy(chatRun.parentMessageId, desc(chatRun.createdAt), desc(chatRun.id)).limit(ids.length) : [];
    if (input.includeActive) {
      const [active] = await tx.select().from(chatRun).where(and(eq(chatRun.userId, parsed.userId), eq(chatRun.conversationId, parsed.conversationId), inArray(chatRun.status, ["queued", "running"]))).orderBy(desc(chatRun.createdAt), desc(chatRun.id)).limit(1);
      if (active && !rows.some(row => row.id === active.id)) rows.push(active);
    }
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).map(viewRun);
  });
}

export async function listSummaryPage(
  db: Db, scope: ChatScope, input: { cursor?: string; limit?: number } = {},
): Promise<{ summaries: SummaryView[]; hasMore: boolean; nextCursor: string | null }> {
  const parsed = chatScopeSchema.parse(scope); validCursor(input.cursor);
  const limit = pageLimit(input.limit, 32, 32);
  return asUser(db, parsed.userId, async (tx) => {
    let cutoff: { id: string } | undefined;
    if (input.cursor) {
      // Soft-deleted cursor rows retain their ordering boundary until eventual purge.
      [cutoff] = await tx.select({ id: userSummary.id }).from(userSummary).where(and(eq(userSummary.userId, parsed.userId), eq(userSummary.id, input.cursor))).limit(1);
      if (!cutoff) throw new ChatPageCursorError();
    }
    const rows = await tx.select().from(userSummary).where(and(eq(userSummary.userId, parsed.userId), isNull(userSummary.deletedAt), ...(cutoff ? [sql`(${userSummary.createdAt}, ${userSummary.id}) < (select s.created_at, s.id from ${userSummary} s where s.id = ${cutoff.id} and s.user_id = ${parsed.userId})`] : []))).orderBy(desc(userSummary.createdAt), desc(userSummary.id)).limit(limit);
    const keys = await keysFor(tx, parsed.userId, new Date());
    const stale = await refreshSummaryFreshness(tx, keys, parsed.userId, rows);
    const summaries: SummaryView[] = []; let bytes = 2;
    for (const row of rows) {
      const view: SummaryView = { id: row.id, title: decrypted<string>(keys, "user_summary", "title", row.id, row.sealedTitle), content: summaryContentSchema.parse(decrypted<unknown>(keys, "user_summary", "content", row.id, row.sealedContent)), freshness: stale.includes(row.id) ? "stale" : row.freshness as "fresh" | "stale", createdAt: row.createdAt, updatedAt: row.updatedAt };
      const size = encodedBytes(view);
      if (size + 2 > CHAT_BROWSER_PAGE_BYTES) throw new ChatPageSizeError();
      if (bytes + size + (summaries.length ? 1 : 0) > CHAT_BROWSER_PAGE_BYTES) break;
      bytes += size + (summaries.length ? 1 : 0); summaries.push(view);
    }
    const oldest = summaries.at(-1);
    let hasMore = rows.length > summaries.length;
    if (!hasMore && oldest && rows.length === limit) {
      const more = await tx.select({ id: userSummary.id }).from(userSummary).where(and(eq(userSummary.userId, parsed.userId), isNull(userSummary.deletedAt), sql`(${userSummary.createdAt}, ${userSummary.id}) < (select s.created_at, s.id from ${userSummary} s where s.id = ${oldest.id} and s.user_id = ${parsed.userId})`)).limit(1);
      hasMore = more.length > 0;
    }
    return { summaries, hasMore, nextCursor: hasMore ? oldest!.id : null };
  });
}
