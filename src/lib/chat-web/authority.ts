import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { canonicalJson } from "@/lib/crypto/user-keys";
import { chatCoordinator, chatRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { asUser } from "@/lib/db/rls";
import type { ChatScope } from "@/lib/chat/contracts";
import { invokeRecordedChatTool } from "@/lib/chat/gateway";
import * as store from "@/lib/chat/store";
import {
  CHAT_CLAIMS_PER_MINUTE, CHAT_DEADLINE_MS, CHAT_LEASE_MS, CHAT_MAX_CONTEXT_BYTES,
  CHAT_MAX_EVENT_BYTES, CHAT_MAX_EVENTS, CHAT_MAX_REQUEST_BYTES, CHAT_MAX_TOOL_OUTPUT_BYTES,
  ChatAuthorityError, claimInputSchema, eventsInputSchema, finalizeInputSchema, toolInputSchema, researchBeginInputSchema, researchResultInputSchema,
  type ClaimInput, type ClaimReply, type ContextReply, type EventsInput, type FinalizeInput,
  type HeartbeatReply, type OperationAck, type ToolInput, type ToolReply, type ResearchBeginInput, type ResearchBeginReply, type ResearchResultInput,
} from "./protocol";

// queueDb sees only immutable bindings and non-content lease metadata. It resolves the
// bearer before the data transaction selects app.user_id; unscoped dataDb cannot see runs.
const locator = {
  id: chatRun.id, userId: chatRun.userId, conversationId: chatRun.conversationId,
  initiatingSessionId: chatRun.initiatingSessionId, coordinatorId: chatRun.coordinatorId,
  claimRequestId: chatRun.claimRequestId, grantedWorkerId: chatRun.grantedWorkerId, status: chatRun.status, attempt: chatRun.attempt,
  leaseOwner: chatRun.leaseOwner, leaseExpiresAt: chatRun.leaseExpiresAt, deadlineAt: chatRun.deadlineAt,
  executionGrantHash: chatRun.executionGrantHash, controlGrantHash: chatRun.controlGrantHash,
  grantsRevokedAt: chatRun.grantsRevokedAt, cancellationRequestedAt: chatRun.cancellationRequestedAt,
};
type LocatedRun = { [K in keyof typeof locator]: typeof chatRun.$inferSelect[K] };
type Run = typeof chatRun.$inferSelect;
type GrantKind = "execution" | "control";
export type AuthorityOptions = { dataDb: Db; queueDb: Db; grantKey: Uint8Array; modelId: string; researchGatewayTokenHash?: string; now?: () => Date };
export function credentialHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function equal(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function parse<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ChatAuthorityError("invalid_request", 400);
  return result.data as T;
}
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function terminal(status: string): boolean { return ["completed", "failed", "cancelled", "interrupted"].includes(status); }

/** Internal metadata lock; no authentication tokens or auth-table write grants are used. */
export async function lockInitiatingSession(tx: Db, sessionId: string, userId: string, at = new Date()): Promise<void> {
  const result = await tx.execute(sql`select public.chat_lock_session(${sessionId}, ${userId}) at time zone 'UTC' as expires_at`) as unknown as { rows: { expires_at: Date | string | null }[] };
  const expires = result.rows[0]?.expires_at;
  if (!expires || !Number.isFinite(new Date(expires).getTime()) || new Date(expires) <= at) throw new ChatAuthorityError("run_not_active");
}

/** Portable Node domain authority. Route adapters never accept a tenant/run scope. */
export class ChatAuthority {
  private readonly now: () => Date;
  constructor(private readonly options: AuthorityOptions) {
    if (options.grantKey.byteLength < 32 || !options.modelId) throw new Error("invalid_chat_authority_configuration");
    this.now = options.now ?? (() => new Date());
  }

  private grant(run: LocatedRun, kind: GrantKind): string {
    if (!run.coordinatorId || !run.claimRequestId || !run.grantedWorkerId) throw new ChatAuthorityError("run_not_active");
    // Web-only keyed derivation permits exact lost-response redelivery with hash-only
    // persistence. Domain separation makes control and execution mutually exclusive.
    const opaque = createHmac("sha256", this.options.grantKey).update(canonicalJson({ version: 1, kind, coordinatorId: run.coordinatorId, requestId: run.claimRequestId, runId: run.id, attempt: run.attempt, workerId: run.grantedWorkerId })).digest("base64url");
    return `whchat1.${kind}.${opaque}`;
  }

  private reply(run: LocatedRun): ClaimReply {
    const executionGrant = this.grant(run, "execution"); const controlGrant = this.grant(run, "control");
    if (!run.deadlineAt || !run.leaseExpiresAt || !run.leaseOwner || !run.executionGrantHash || !run.controlGrantHash || !equal(credentialHash(executionGrant), run.executionGrantHash) || !equal(credentialHash(controlGrant), run.controlGrantHash)) throw new ChatAuthorityError("claim_conflict");
    return { id: run.id, attempt: run.attempt, leaseOwner: run.leaseOwner, deadlineAt: run.deadlineAt.toISOString(), leaseExpiresAt: run.leaseExpiresAt.toISOString(), executionGrant, controlGrant };
  }

  async claim(bootstrapToken: string, raw: ClaimInput): Promise<ClaimReply | null> {
    const input = parse<ClaimInput>(claimInputSchema, raw); const now = this.now();
    if (!bootstrapToken || bootstrapToken.length > 256) throw new ChatAuthorityError("unauthorized", 401);
    return this.options.queueDb.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [coordinator] = await tx.select().from(chatCoordinator).where(eq(chatCoordinator.credentialHash, credentialHash(bootstrapToken))).limit(1).for("update");
      if (!coordinator || coordinator.disabledAt) throw new ChatAuthorityError("unauthorized", 401);
      const [previous] = await tx.select(locator).from(chatRun).where(and(eq(chatRun.coordinatorId, coordinator.id), eq(chatRun.claimRequestId, input.requestId))).limit(1);
      if (previous) {
        if (previous.leaseOwner !== input.workerId || previous.status !== "running" || previous.grantsRevokedAt || previous.cancellationRequestedAt || !previous.deadlineAt || previous.deadlineAt <= now || !previous.leaseExpiresAt || previous.leaseExpiresAt <= now || !previous.initiatingSessionId) throw new ChatAuthorityError("claim_conflict");
        await lockInitiatingSession(tx, previous.initiatingSessionId, previous.userId, now);
        const [locked] = await tx.select(locator).from(chatRun).where(eq(chatRun.id, previous.id)).limit(1).for("update");
        if (!locked || locked.status !== "running" || locked.grantsRevokedAt || locked.cancellationRequestedAt) throw new ChatAuthorityError("claim_conflict");
        return this.reply(locked);
      }
      const reset = now.getTime() - coordinator.claimWindowAt.getTime() >= 60_000;
      const count = reset ? 0 : coordinator.claimCount;
      if (count >= CHAT_CLAIMS_PER_MINUTE) throw new ChatAuthorityError("quota_exceeded", 429);
      await tx.update(chatCoordinator).set({ claimWindowAt: reset ? now : coordinator.claimWindowAt, claimCount: count + 1 }).where(eq(chatCoordinator.id, coordinator.id));
      const [active] = await tx.select({ id: chatRun.id }).from(chatRun).where(and(eq(chatRun.coordinatorId, coordinator.id), eq(chatRun.status, "running"), gt(chatRun.leaseExpiresAt, now), gt(chatRun.deadlineAt, now))).limit(1);
      if (active) return null;
      // Claim only ready jobs; a candidate's session is locked before the run row.
      const candidates = await tx.select(locator).from(chatRun).where(and(eq(chatRun.status, "queued"), lte(chatRun.nextAttemptAt, now), isNull(chatRun.cancellationRequestedAt))).orderBy(asc(chatRun.createdAt)).limit(20);
      for (const candidate of candidates) {
        if (!candidate.initiatingSessionId) continue;
        try { await lockInitiatingSession(tx, candidate.initiatingSessionId, candidate.userId, now); }
        catch (error) { if (error instanceof ChatAuthorityError) continue; throw error; }
        const [current] = await tx.select(locator).from(chatRun).where(and(eq(chatRun.id, candidate.id), eq(chatRun.status, "queued"), isNull(chatRun.cancellationRequestedAt))).limit(1).for("update", { skipLocked: true });
        if (!current) continue;
        const claimed: LocatedRun = { ...current, status: "running", coordinatorId: coordinator.id, claimRequestId: input.requestId, attempt: current.attempt + 1, leaseOwner: input.workerId, grantedWorkerId: input.workerId, leaseExpiresAt: new Date(now.getTime() + CHAT_LEASE_MS), deadlineAt: new Date(now.getTime() + CHAT_DEADLINE_MS), grantsRevokedAt: null };
        claimed.executionGrantHash = credentialHash(this.grant(claimed, "execution")); claimed.controlGrantHash = credentialHash(this.grant(claimed, "control"));
        await tx.update(chatRun).set({ status: "running", coordinatorId: claimed.coordinatorId, claimRequestId: claimed.claimRequestId, grantedWorkerId: claimed.grantedWorkerId, attempt: claimed.attempt, leaseOwner: claimed.leaseOwner, leaseExpiresAt: claimed.leaseExpiresAt, deadlineAt: claimed.deadlineAt, executionGrantHash: claimed.executionGrantHash, controlGrantHash: claimed.controlGrantHash, grantsRevokedAt: null, startedAt: now, nextWorkerSequence: 0, updatedAt: now }).where(eq(chatRun.id, claimed.id));
        return this.reply(claimed);
      }
      return null;
    });
  }

  private async locate(token: string, kind: GrantKind): Promise<LocatedRun> {
    if (!/^whchat1\.(execution|control)\.[A-Za-z0-9_-]{43}$/.test(token) || !token.startsWith(`whchat1.${kind}.`)) throw new ChatAuthorityError("unauthorized", 401);
    const [run] = await this.options.queueDb.transaction(tx => tx.select(locator).from(chatRun).where(eq(kind === "execution" ? chatRun.executionGrantHash : chatRun.controlGrantHash, credentialHash(token))).limit(1));
    if (!run || !run.coordinatorId || !run.initiatingSessionId) throw new ChatAuthorityError("unauthorized", 401);
    return run;
  }

  private scope(run: Run): ChatScope { return { userId: run.userId, conversationId: run.conversationId, runId: run.id, runAttempt: run.attempt, workerId: run.grantedWorkerId ?? undefined }; }
  private active(run: Run, kind: GrantKind, allowTerminal: boolean): void {
    const now = this.now();
    if ((run.status === "running" && run.leaseOwner !== run.grantedWorkerId) || run.grantsRevokedAt || !run.deadlineAt || run.deadlineAt <= now || (!allowTerminal && (!run.leaseExpiresAt || run.leaseExpiresAt <= now || run.status !== "running")) || (allowTerminal && !terminal(run.status) && (!run.leaseExpiresAt || run.leaseExpiresAt <= now || run.status !== "running")) || (kind === "execution" && run.cancellationRequestedAt)) throw new ChatAuthorityError("run_not_active");
  }

  private async authorized<T>(token: string, kind: GrantKind, allowTerminal: boolean, work: (tx: Db, run: Run, scope: ChatScope) => Promise<T>): Promise<T> {
    const located = await this.locate(token, kind);
    return asUser(this.options.dataDb, located.userId, async (tx) => {
      // Every worker operation and operator disablement shares this lock order.
      const [coordinator] = await tx.select().from(chatCoordinator).where(eq(chatCoordinator.id, located.coordinatorId!)).limit(1).for("update");
      if (!coordinator || coordinator.disabledAt) throw new ChatAuthorityError("run_not_active");
      await lockInitiatingSession(tx, located.initiatingSessionId!, located.userId, this.now());
      const [run] = await tx.select().from(chatRun).where(and(eq(chatRun.id, located.id), eq(chatRun.userId, located.userId), eq(chatRun.conversationId, located.conversationId))).limit(1).for("update");
      if (!run || run.coordinatorId !== located.coordinatorId || run.initiatingSessionId !== located.initiatingSessionId || run.attempt !== located.attempt || (kind === "execution" ? run.executionGrantHash : run.controlGrantHash) !== credentialHash(token)) throw new ChatAuthorityError("run_not_active");
      if (!equal(credentialHash(this.grant(run, kind)), credentialHash(token))) throw new ChatAuthorityError("run_not_active");
      this.active(run, kind, allowTerminal);
      const result = await work(tx, run, this.scope(run));
      // Clock/session expiry during an in-flight call rolls back writes and refuses PHI.
      this.active(run, kind, allowTerminal);
      await lockInitiatingSession(tx, run.initiatingSessionId!, run.userId, this.now());
      return result;
    });
  }

  private async budget(tx: Db, run: Run, name: string, amount: number, maximum: number): Promise<void> {
    const used = Number(run.executionMeta[name] ?? 0);
    if (!Number.isFinite(used) || used + amount > maximum) throw new ChatAuthorityError("quota_exceeded", 429);
    run.executionMeta = { ...run.executionMeta, [name]: used + amount };
    await tx.update(chatRun).set({ executionMeta: run.executionMeta }).where(and(eq(chatRun.id, run.id), eq(chatRun.userId, run.userId)));
  }

  async context(token: string): Promise<ContextReply> {
    return this.authorized(token, "execution", false, async (tx, run, scope) => {
      if (Number(run.executionMeta.contextBytes ?? 0) >= CHAT_MAX_CONTEXT_BYTES) throw new ChatAuthorityError("quota_exceeded", 429);
      const context = await store.loadRunContext(tx, scope);
      const result = { messages: context.messages.map(({ role, content }) => ({ role, content })), modelId: this.options.modelId };
      await this.budget(tx, run, "contextBytes", bytes(result), CHAT_MAX_CONTEXT_BYTES);
      return result;
    });
  }

  async cancellation(token: string): Promise<{ cancelled: boolean }> {
    try { return await this.authorized(token, "execution", false, async () => ({ cancelled: false })); }
    catch (error) { if (error instanceof ChatAuthorityError && error.code === "run_not_active") return { cancelled: true }; throw error; }
  }

  async tool(token: string, raw: ToolInput): Promise<ToolReply> {
    const input = parse<ToolInput>(toolInputSchema, raw);
    if (bytes(input) > CHAT_MAX_REQUEST_BYTES) throw new ChatAuthorityError("invalid_request", 400);
    return this.authorized(token, "execution", false, async (tx, run, scope) => {
      if (Number(run.executionMeta.toolOutputBytes ?? 0) >= CHAT_MAX_TOOL_OUTPUT_BYTES) throw new ChatAuthorityError("quota_exceeded", 429);
      const result = await invokeRecordedChatTool(tx, scope, { providerToolCallId: input.toolCallId, tool: input.tool, rawInput: input.input });
      const output = Array.isArray(result.output) ? { items: result.output } : result.output && typeof result.output === "object" ? result.output as Record<string, unknown> : { value: result.output };
      await this.budget(tx, run, "toolOutputBytes", bytes(output), CHAT_MAX_TOOL_OUTPUT_BYTES);
      return { status: "completed", output };
    });
  }

  private authorizeResearchGateway(token: string): void {
    const expected = this.options.researchGatewayTokenHash;
    // Optional/malformed configuration disables only research, never ordinary patient chat.
    if (!expected || !/^[a-f0-9]{64}$/.test(expected) || !/^[A-Za-z0-9_-]{43}$/.test(token) || !equal(credentialHash(token), expected)) throw new ChatAuthorityError("unauthorized", 401);
  }

  async researchBegin(token: string, gatewayToken: string, raw: ResearchBeginInput): Promise<ResearchBeginReply> {
    this.authorizeResearchGateway(gatewayToken);
    const input = parse<ResearchBeginInput>(researchBeginInputSchema, raw);
    if (bytes(input) > CHAT_MAX_REQUEST_BYTES) throw new ChatAuthorityError("invalid_request", 400);
    return this.authorized(token, "execution", false, async (tx, run, scope) => {
      const pinned = run.executionMeta.researchSnapshotId;
      if (pinned !== undefined && (typeof pinned !== "string" || !/^[a-f0-9]{64}$/.test(pinned))) throw new ChatAuthorityError("invalid_request", 409);
      const snapshotId = typeof pinned === "string" ? pinned : input.proposedSnapshotId;
      if (input.tool === "read_research" && input.input.snapshotId !== snapshotId) throw new ChatAuthorityError("invalid_request", 409);
      const begun = await store.beginRecordedResearchCall(tx, scope, input, snapshotId, this.now());
      if (begun.status === "started") {
        if (snapshotId === null) throw new ChatAuthorityError("invalid_request", 400);
        if (Number(run.executionMeta.toolOutputBytes ?? 0) >= CHAT_MAX_TOOL_OUTPUT_BYTES) throw new ChatAuthorityError("quota_exceeded", 429);
        run.executionMeta = { ...run.executionMeta, researchSnapshotId: snapshotId };
        await tx.update(chatRun).set({ executionMeta: run.executionMeta }).where(and(eq(chatRun.id, run.id), eq(chatRun.userId, run.userId)));
      }
      if (begun.status === "completed") return { status: "completed", operationId: begun.operationId, output: begun.output };
      if (begun.status === "failed") return { status: "failed", operationId: begun.operationId, errorCode: begun.errorCode };
      if (snapshotId === null) throw new ChatAuthorityError("invalid_request", 400);
      return { status: "execute", operationId: begun.operationId, snapshotId, deadlineAt: run.deadlineAt!.toISOString() };
    });
  }

  async researchResult(token: string, gatewayToken: string, raw: ResearchResultInput): Promise<OperationAck> {
    this.authorizeResearchGateway(gatewayToken);
    const input = parse<ResearchResultInput>(researchResultInputSchema, raw);
    if (bytes(input) > CHAT_MAX_REQUEST_BYTES) throw new ChatAuthorityError("invalid_request", 400);
    return this.authorized(token, "execution", false, async (tx, run, scope) => {
      const result = await store.finishRecordedResearchCall(tx, scope, input, this.now());
      if (result.status === "accepted" && result.outputBytes) await this.budget(tx, run, "toolOutputBytes", result.outputBytes, CHAT_MAX_TOOL_OUTPUT_BYTES);
      return { status: result.status };
    });
  }

  async events(token: string, raw: EventsInput): Promise<OperationAck> {
    const input = parse<EventsInput>(eventsInputSchema, raw);
    if (bytes(input) > CHAT_MAX_REQUEST_BYTES) throw new ChatAuthorityError("invalid_request", 400);
    if (input.events.slice(0, -1).some(event => ["completed", "cancelled", "error"].includes(event.type))) throw new ChatAuthorityError("invalid_request", 400);
    return this.authorized(token, "execution", true, async (tx, run, scope) => {
      if (terminal(run.status)) {
        const last = input.events.at(-1)!;
        const expected = last.type === "completed" ? "completed" : last.type === "error" ? "failed" : last.type === "cancelled" ? "cancelled" : undefined;
        if (expected !== run.status) throw new ChatAuthorityError("run_not_active");
        // The store's keyed immutable digest validates all repeated payloads. No PHI
        // is returned, no budgets/state are reopened, and expired/revoked tokens fail.
        for (const event of input.events) {
          const result = await store.appendWorkerEvent(tx, scope, event, this.now());
          if (result.status !== "duplicate") throw new ChatAuthorityError("run_not_active");
        }
        return { status: "duplicate" };
      }
      let accepted = false;
      for (const event of input.events) {
        const isTerminal = ["completed", "cancelled", "error"].includes(event.type);
        if (isTerminal) {
          await store.finalizeWorkerEvent(tx, scope, { event, status: event.type === "completed" ? "completed" : event.type === "cancelled" ? "cancelled" : "failed", assistantContent: event.type === "completed" ? event.data.answer as string : undefined, now: this.now() });
          accepted = true;
        } else {
          const result = await store.appendWorkerEvent(tx, scope, event, this.now());
          if (result.status === "out_of_order") throw new ChatAuthorityError("invalid_request", 409);
          accepted ||= result.status === "appended";
        }
      }
      if (accepted) {
        await this.budget(tx, run, "eventBytes", bytes(input), CHAT_MAX_EVENT_BYTES);
        await this.budget(tx, run, "eventCount", input.events.length, CHAT_MAX_EVENTS);
      }
      return { status: accepted ? "accepted" : "duplicate" };
    });
  }

  async heartbeat(token: string): Promise<HeartbeatReply> {
    return this.authorized(token, "control", true, async (tx, run) => {
      const cancelled = !!run.cancellationRequestedAt;
      const active = run.status === "running" && !cancelled;
      if (active) await tx.update(chatRun).set({ leaseExpiresAt: new Date(Math.min(this.now().getTime() + CHAT_LEASE_MS, run.deadlineAt!.getTime())), updatedAt: this.now() }).where(eq(chatRun.id, run.id));
      return { active, cancelled, deadlineAt: run.deadlineAt!.toISOString() };
    });
  }

  async finalize(token: string, raw: FinalizeInput): Promise<OperationAck> {
    const input = parse<FinalizeInput>(finalizeInputSchema, raw);
    return this.authorized(token, "control", true, async (tx, run, scope) => {
      const digest = createHmac("sha256", this.options.grantKey).update(canonicalJson(input)).digest("hex");
      if (terminal(run.status)) {
        if (run.executionMeta.controlFinalizeDigest !== digest || run.status !== input.status) throw new ChatAuthorityError("run_not_active");
        return { status: "duplicate" };
      }
      if (input.status === "cancelled" && !run.cancellationRequestedAt) throw new ChatAuthorityError("invalid_request", 400);
      if (input.status === "interrupted") {
        await tx.update(chatRun).set({ status: "interrupted", completedAt: this.now(), leaseOwner: null, leaseExpiresAt: null }).where(eq(chatRun.id, run.id));
      } else await store.finalizeServiceEvent(tx, scope, { event: { eventId: input.requestId, type: input.status === "cancelled" ? "cancelled" : "error", data: input.errorCode ? { code: input.errorCode } : {} }, status: input.status, now: this.now() });
      await store.closePendingResearchCalls(tx, scope, this.now());
      await tx.update(chatRun).set({ executionMeta: { ...run.executionMeta, controlFinalizeDigest: digest } }).where(eq(chatRun.id, run.id));
      return { status: "accepted" };
    });
  }

  /** Web-scheduled independently of VPS liveness; only scoped metadata is changed. */
  async reap(): Promise<number> {
    const now = this.now();
    // The queue role can discover identities but cannot touch encrypted tool traces.
    // Each run transition and its pending-call cleanup commits atomically as that user.
    const candidates = await this.options.queueDb.transaction(async rawTx => {
      const tx = rawTx as unknown as Db;
      const expired = await tx.select(locator).from(chatRun).where(and(eq(chatRun.status, "running"), or(lte(chatRun.leaseExpiresAt, now), lte(chatRun.deadlineAt, now), isNull(chatRun.initiatingSessionId), sql`${chatRun.grantsRevokedAt} is not null`, sql`exists (select 1 from ${chatCoordinator} where ${chatCoordinator.id} = ${chatRun.coordinatorId} and ${chatCoordinator.disabledAt} is not null)`))).orderBy(asc(chatRun.createdAt)).limit(100);
      const queued = await tx.select(locator).from(chatRun).where(eq(chatRun.status, "queued")).orderBy(asc(chatRun.createdAt)).limit(100);
      return [...expired, ...queued];
    });
    let count = 0;
    for (const candidate of candidates) count += await asUser(this.options.dataDb, candidate.userId, async tx => {
      let disabled = false;
      if (candidate.coordinatorId) {
        const [coordinator] = await tx.select().from(chatCoordinator).where(eq(chatCoordinator.id, candidate.coordinatorId)).limit(1).for("update");
        disabled = !coordinator || !!coordinator.disabledAt;
      }
      let validSession = !!candidate.initiatingSessionId;
      if (validSession) try { await lockInitiatingSession(tx, candidate.initiatingSessionId!, candidate.userId, this.now()); }
      catch (error) { if (error instanceof ChatAuthorityError) validSession = false; else throw error; }
      const [run] = await tx.select().from(chatRun).where(and(eq(chatRun.id, candidate.id), eq(chatRun.userId, candidate.userId))).limit(1).for("update");
      if (!run || run.initiatingSessionId !== candidate.initiatingSessionId || run.coordinatorId !== candidate.coordinatorId) return 0;
      const at = this.now();
      if (run.status === "queued") {
        if (validSession && !disabled) return 0;
        await tx.update(chatRun).set({ status: "cancelled", cancellationRequestedAt: at, completedAt: at, grantsRevokedAt: at, updatedAt: at }).where(and(eq(chatRun.id, run.id), eq(chatRun.userId, run.userId)));
      } else if (run.status === "running") {
        if (validSession && !disabled && !run.grantsRevokedAt && run.leaseExpiresAt && run.leaseExpiresAt > at && run.deadlineAt && run.deadlineAt > at) return 0;
        await tx.update(chatRun).set({ status: "interrupted", leaseOwner: null, leaseExpiresAt: null, grantsRevokedAt: at, completedAt: at, updatedAt: at }).where(and(eq(chatRun.id, run.id), eq(chatRun.userId, run.userId)));
      } else return 0;
      await store.closePendingResearchCalls(tx, { userId: run.userId, conversationId: run.conversationId, runId: run.id }, at);
      return 1;
    });
    return count;
  }

  /** Operator-only internal method: never mounted as a coordinator endpoint. */
  async disableCoordinator(id: string): Promise<void> {
    const candidates = await this.options.queueDb.transaction(async rawTx => {
      const tx = rawTx as unknown as Db;
      const [row] = await tx.select().from(chatCoordinator).where(eq(chatCoordinator.id, id)).limit(1).for("update");
      if (!row) return [];
      await tx.update(chatCoordinator).set({ disabledAt: this.now() }).where(eq(chatCoordinator.id, id));
      return tx.select(locator).from(chatRun).where(and(eq(chatRun.coordinatorId, id), inArray(chatRun.status, ["queued", "running"])));
    });
    // Disablement already denies grants. If interrupted here, the independent reaper
    // discovers the disabled coordinator and performs the same atomic cleanup.
    for (const candidate of candidates) await asUser(this.options.dataDb, candidate.userId, async tx => {
      await tx.select().from(chatCoordinator).where(eq(chatCoordinator.id, id)).limit(1).for("update");
      const [run] = await tx.select().from(chatRun).where(and(eq(chatRun.id, candidate.id), eq(chatRun.userId, candidate.userId), eq(chatRun.coordinatorId, id))).limit(1).for("update");
      if (!run || !["queued", "running"].includes(run.status)) return;
      const now = this.now();
      await tx.update(chatRun).set({ grantsRevokedAt: now, status: "interrupted", leaseOwner: null, leaseExpiresAt: null, completedAt: now, updatedAt: now }).where(and(eq(chatRun.id, run.id), eq(chatRun.userId, run.userId)));
      await store.closePendingResearchCalls(tx, { userId: run.userId, conversationId: run.conversationId, runId: run.id }, now);
    });
  }
}
