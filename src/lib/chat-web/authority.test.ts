import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { sealField, userKeysFor } from "@/lib/crypto/user-keys";
import { chatCoordinator, chatEvent, chatRun, chatToolCall, fhirAttachment, fhirResource, healthSource, session, userSummary } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createConversation, listMessages, requestRunCancellation, submitQuestionAndRun } from "@/lib/chat/store";
import { ChatAuthority, credentialHash } from "./authority";
import { assertChatDatabaseRoles } from "./role-preflight";
import { CHAT_DEADLINE_MS, type ClaimReply } from "./protocol";

async function fixture() {
  const db = await createTestDb();
  const client = (db as unknown as { $client: PGlite }).$client;
  const provisioning = await readFile("scripts/provision-chat-roles.sql", "utf8");
  await client.exec(provisioning.slice(provisioning.indexOf("BEGIN;")).replace(/PASSWORD :'chat_(data|queue)_password'/g, ""));
  const roleDb = (role: string) => new Proxy(db, { get(target, property) {
    if (property === "transaction") return (work: (tx: Db) => Promise<unknown>) => target.transaction(async rawTx => {
      const tx = rawTx as unknown as Db; await tx.execute(sql.raw(`set local role ${role}`)); return work(tx);
    });
    return Reflect.get(target, property);
  } });
  const dataDb = roleDb("wildhearts_chat_data"); const queueDb = roleDb("wildhearts_chat_queue");
  const alice = await createTestUser(db, "authority_alice"); const bob = await createTestUser(db, "authority_bob");
  let time = new Date();
  for (const userId of [alice, bob]) await db.insert(session).values({ id: `session-${userId}`, userId, token: `synthetic-${userId}`, expiresAt: new Date(time.getTime() + 3600_000), createdAt: time, updatedAt: time });
  const bootstrap = "synthetic-bootstrap-credential-with-32-bytes";
  const [coordinator] = await db.insert(chatCoordinator).values({ credentialHash: credentialHash(bootstrap), claimWindowAt: time }).returning();
  const authority = new ChatAuthority({ dataDb, queueDb, grantKey: Buffer.alloc(32, 9), modelId: "synthetic-model", now: () => time });
  const conversations = new Map<string, string>();
  for (const userId of [alice, bob]) conversations.set(userId, (await createConversation(dataDb, { userId })).id);
  const submit = async (userId = alice, initiatingSessionId: string | undefined = `session-${userId}`) => submitQuestionAndRun(dataDb, { userId, conversationId: conversations.get(userId)! }, { message: "Synthetic health question", idempotencyKey: randomUUID(), initiatingSessionId, now: time });
  const claim = async () => (await authority.claim(bootstrap, { requestId: randomUUID(), workerId: "worker-1" }))!;
  const roleClient = (role: string) => ({ query: (text: string, values?: unknown[]) => client.transaction(async tx => { await tx.exec(`set local role ${role}`); return tx.query<Record<string, unknown>>(text, values); }) });
  const record = async (userId: string) => {
    const keys = await userKeysFor(db, Buffer.from(process.env.RECORDS_ENCRYPTION_KEY!, "base64"), userId, time);
    const [source] = await db.insert(healthSource).values({ userId, vendor: "epic", fhirBaseUrl: `https://${userId}.example/R4`, organizationName: "Synthetic source", status: "disconnected" }).returning();
    const id = randomUUID();
    await db.insert(fhirResource).values({ id, userId, sourceId: source.id, resourceType: "Observation", fhirId: id, category: "lab", contentHmac: `synthetic-version-${id}`, sealedResource: sealField(keys, JSON.stringify({ resourceType: "Observation" }), { table: "fhir_resource", field: "resource", rowId: id }), sealedSummary: sealField(keys, JSON.stringify({ title: "Synthetic lab", category: "lab" }), { table: "fhir_resource", field: "summary", rowId: id }), normalizerVersion: 2, firstSeenAt: time, lastSeenAt: time });
    return id;
  };
  const note = async (userId: string, recordId: string) => {
    const [parent] = await db.select({ sourceId: fhirResource.sourceId }).from(fhirResource).where(eq(fhirResource.id, recordId));
    const keys = await userKeysFor(db, Buffer.from(process.env.RECORDS_ENCRYPTION_KEY!, "base64"), userId, time);
    const id = randomUUID();
    await db.insert(fhirAttachment).values({ id, userId, sourceId: parent.sourceId, resourceId: recordId, sealedUrl: "synthetic-unused", urlHmac: id, sealedText: sealField(keys, "Synthetic note text", { table: "fhir_attachment", field: "text", rowId: id }), fetchedAt: time });
    return id;
  };
  return { db, dataDb, queueDb, authority, bootstrap, coordinator, alice, bob, conversations, submit, claim, record, note, time: () => time, advance: (ms: number) => { time = new Date(time.getTime() + ms); }, dataClient: roleClient("wildhearts_chat_data"), queueClient: roleClient("wildhearts_chat_queue") };
}
const completion = (sequence = 1) => ({ eventId: randomUUID(), sequence, type: "completed" as const, data: { answer: "Synthetic complete answer" } });

describe("web-owned chat authority with constrained PostgreSQL roles", () => {
  it("passes role preflight, resolves an opaque grant through metadata role and stores only hashes", async () => {
    const f = await fixture();
    const client = (f.db as unknown as { $client: PGlite }).$client;
    const upgrade = await readFile("scripts/upgrade-chat-roles.sql", "utf8");
    await client.exec(upgrade); await client.exec(upgrade);
    await assertChatDatabaseRoles(f.dataClient, f.queueClient);
    await f.submit(); const claim = await f.claim();
    expect(claim).not.toHaveProperty("userId");
    expect(await f.dataDb.transaction(tx => tx.select().from(chatRun))).toEqual([]);
    expect(await f.authority.context(claim.executionGrant)).toMatchObject({ messages: [{ role: "user", content: "Synthetic health question" }], modelId: "synthetic-model" });
    const [run] = await f.db.select().from(chatRun); const persisted = JSON.stringify(run);
    expect(persisted).not.toContain(claim.executionGrant); expect(persisted).not.toContain(claim.controlGrant); expect(persisted).not.toContain("Synthetic health question");
    await expect(f.authority.context(claim.controlGrant)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(f.authority.heartbeat(claim.executionGrant)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("recovers a lost claim without another job, attempt or deadline, rejects changed worker and identity injection", async () => {
    const f = await fixture(); await f.submit(); await f.submit(f.bob);
    const request = { requestId: randomUUID(), workerId: "worker-1" };
    const first = await f.authority.claim(f.bootstrap, request);
    expect(await f.authority.claim(f.bootstrap, request)).toEqual(first);
    await expect(f.authority.claim(f.bootstrap, { ...request, workerId: "worker-2" })).rejects.toMatchObject({ code: "claim_conflict" });
    await expect(f.authority.claim(f.bootstrap, { ...request, userId: f.bob } as typeof request)).rejects.toMatchObject({ code: "invalid_request" });
    expect(await f.authority.claim(f.bootstrap, { requestId: randomUUID(), workerId: "worker-2" })).toBeNull();
    const runs = await f.db.select().from(chatRun); expect(runs.filter(run => run.status === "running")).toHaveLength(1); expect(runs.filter(run => run.status === "queued")).toHaveLength(1);
  });

  it("rejects expired leases before independent reaping and never retries begun work", async () => {
    const f = await fixture(); await f.submit(); const claim = await f.claim(); f.advance(30_001);
    await expect(f.authority.context(claim.executionGrant)).rejects.toMatchObject({ code: "run_not_active" });
    expect(await f.authority.reap()).toBe(1);
    expect(await f.authority.claim(f.bootstrap, { requestId: randomUUID(), workerId: "worker-1" })).toBeNull();
    expect((await f.db.select().from(chatRun))[0].status).toBe("interrupted");
  });

  it("caps heartbeats under one five-minute deadline and rejects stale attempts and swapped workers", async () => {
    const f = await fixture(); await f.submit(); const claim = await f.claim();
    await f.db.update(chatRun).set({ leaseExpiresAt: new Date(claim.deadlineAt) }).where(eq(chatRun.id, claim.id));
    f.advance(CHAT_DEADLINE_MS - 1_000);
    expect(await f.authority.heartbeat(claim.controlGrant)).toMatchObject({ active: true, deadlineAt: claim.deadlineAt });
    expect((await f.db.select().from(chatRun))[0].leaseExpiresAt?.toISOString()).toBe(claim.deadlineAt);
    f.advance(1_001); await expect(f.authority.heartbeat(claim.controlGrant)).rejects.toMatchObject({ code: "run_not_active" });
    const g = await fixture(); await g.submit(); const c = await g.claim();
    await g.db.update(chatRun).set({ attempt: c.attempt + 1 }).where(eq(chatRun.id, c.id));
    await expect(g.authority.context(c.executionGrant)).rejects.toMatchObject({ code: "run_not_active" });
    await g.db.update(chatRun).set({ attempt: c.attempt, leaseOwner: "other-worker" }).where(eq(chatRun.id, c.id));
    await expect(g.authority.context(c.executionGrant)).rejects.toMatchObject({ code: "run_not_active" });
  });

  it("fences logout and expired sessions without deleting history; tab closure needs no action", async () => {
    const f = await fixture(); await f.submit(); const claim = await f.claim();
    expect(await f.authority.context(claim.executionGrant)).toHaveProperty("messages");
    await f.db.delete(session).where(eq(session.id, `session-${f.alice}`));
    await expect(f.authority.context(claim.executionGrant)).rejects.toMatchObject({ code: "run_not_active" });
    await expect(f.authority.events(claim.executionGrant, { events: [completion()] })).rejects.toMatchObject({ code: "run_not_active" });
    expect(await listMessages(f.dataDb, { userId: f.alice, conversationId: f.conversations.get(f.alice)! })).toHaveLength(1);
    const g = await fixture(); await g.submit(); const c = await g.claim();
    await g.db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.id, `session-${g.alice}`));
    await expect(g.authority.context(c.executionGrant)).rejects.toMatchObject({ code: "run_not_active" });
  });

  it("protects PHI tool replay, exact event retries and atomic final flush", async () => {
    const f = await fixture(); await f.submit(); const c = await f.claim();
    const tool = { toolCallId: "coverage_1", tool: "get_data_coverage" as const, input: {} };
    expect(await f.authority.tool(c.executionGrant, tool)).toEqual(await f.authority.tool(c.executionGrant, tool));
    await expect(f.authority.tool(c.executionGrant, { ...tool, tool: "find_records" })).rejects.toThrow();
    const events = [{ eventId: randomUUID(), sequence: 1, type: "answer.delta" as const, data: { text: "Synthetic partial" } }, completion(2)];
    expect(await f.authority.events(c.executionGrant, { events })).toEqual({ status: "accepted" });
    expect(await f.authority.events(c.executionGrant, { events })).toEqual({ status: "duplicate" });
    await expect(f.authority.events(c.executionGrant, { events: [{ ...events[1], data: { answer: "Altered answer" } }] })).rejects.toThrow();
    await expect(f.authority.tool(c.executionGrant, tool)).rejects.toMatchObject({ code: "run_not_active" });
    expect(await f.db.select().from(chatEvent)).toHaveLength(2); expect(await f.db.select().from(chatToolCall)).toHaveLength(1);
    expect((await listMessages(f.dataDb, { userId: f.alice, conversationId: f.conversations.get(f.alice)! })).at(-1)).toMatchObject({ content: "Synthetic complete answer", status: "completed" });
  });

  it("rejects cancelled writes and uses lease-bound control acknowledgement", async () => {
    const f = await fixture(); const submitted = await f.submit(); const c = await f.claim();
    await requestRunCancellation(f.dataDb, { userId: f.alice, conversationId: f.conversations.get(f.alice)!, runId: submitted.run.id });
    await expect(f.authority.context(c.executionGrant)).rejects.toMatchObject({ code: "run_not_active" });
    await expect(f.authority.events(c.executionGrant, { events: [completion()] })).rejects.toMatchObject({ code: "run_not_active" });
    expect(await f.authority.heartbeat(c.controlGrant)).toMatchObject({ active: false, cancelled: true });
    const finish = { requestId: randomUUID(), status: "cancelled" as const };
    expect(await f.authority.finalize(c.controlGrant, finish)).toEqual({ status: "accepted" });
    expect(await f.authority.finalize(c.controlGrant, finish)).toEqual({ status: "duplicate" });
    await expect(f.authority.finalize(c.controlGrant, { ...finish, status: "failed" })).rejects.toMatchObject({ code: "run_not_active" });
  });

  it("requires current-run read evidence and excludes incomplete summaries from recall", async () => {
    const f = await fixture(); const own = await f.record(f.alice); const foreign = await f.record(f.bob); await f.submit(); const c = await f.claim();
    const summary = { title: "Synthetic summary", text: "Synthetic derived content", coverageState: "partial", evidence: [{ kind: "record", targetId: own }] };
    await expect(f.authority.tool(c.executionGrant, { toolCallId: "no_read", tool: "save_summary", input: summary })).rejects.toThrow();
    const read = await f.authority.tool(c.executionGrant, { toolCallId: "records_1", tool: "read_records", input: { recordIds: [own, foreign] } });
    expect(read.output.items).toHaveLength(1);
    const foreignNote = await f.note(f.bob, foreign);
    expect(await f.authority.tool(c.executionGrant, { toolCallId: "foreign_note", tool: "read_stored_note", input: { attachmentId: foreignNote } })).toMatchObject({ output: { available: false } });
    await expect(f.authority.tool(c.executionGrant, { toolCallId: "foreign_summary", tool: "save_summary", input: { ...summary, evidence: [{ kind: "record", targetId: foreign }] } })).rejects.toThrow();
    const saved = await f.authority.tool(c.executionGrant, { toolCallId: "supported_summary", tool: "save_summary", input: summary }); expect(saved.output).toHaveProperty("id");
    expect(await f.authority.tool(c.executionGrant, { toolCallId: "recall_staged", tool: "find_saved_summaries", input: {} })).toMatchObject({ output: { items: [] } });
    await f.authority.events(c.executionGrant, { events: [completion()] });
    expect((await f.db.select().from(userSummary))).toHaveLength(1);
    const nextConversation = (await createConversation(f.dataDb, { userId: f.alice })).id;
    await submitQuestionAndRun(f.dataDb, { userId: f.alice, conversationId: nextConversation }, { message: "Synthetic follow-up", idempotencyKey: randomUUID(), initiatingSessionId: `session-${f.alice}`, now: f.time() });
    const next = await f.claim();
    expect(await f.authority.tool(next.executionGrant, { toolCallId: "recall_completed", tool: "find_saved_summaries", input: {} })).toMatchObject({ output: { items: [expect.objectContaining({ title: "Synthetic summary" })] } });
  });

  it("rejects changed read evidence and makes completed note-derived summaries stale after source amendment", async () => {
    const f = await fixture(); const record = await f.record(f.alice); const note = await f.note(f.alice, record); await f.submit(); const c = await f.claim();
    await f.authority.tool(c.executionGrant, { toolCallId: "read_version", tool: "read_records", input: { recordIds: [record] } });
    await f.db.update(fhirResource).set({ contentHmac: "synthetic-new-version" }).where(eq(fhirResource.id, record));
    await expect(f.authority.tool(c.executionGrant, { toolCallId: "changed_evidence", tool: "save_summary", input: { title: "Synthetic", text: "Derived", coverageState: "partial", evidence: [{ kind: "record", targetId: record }] } })).rejects.toThrow();
    await f.authority.tool(c.executionGrant, { toolCallId: "read_note", tool: "read_stored_note", input: { attachmentId: note } });
    await f.authority.tool(c.executionGrant, { toolCallId: "note_summary", tool: "save_summary", input: { title: "Synthetic note summary", text: "Derived note", coverageState: "partial", evidence: [{ kind: "note", targetId: note }] } });
    await f.authority.events(c.executionGrant, { events: [completion()] });
    await f.db.update(fhirResource).set({ supersededAt: f.time() }).where(eq(fhirResource.id, record));
    const conversationId = (await createConversation(f.dataDb, { userId: f.alice })).id;
    await submitQuestionAndRun(f.dataDb, { userId: f.alice, conversationId }, { message: "Synthetic recall", idempotencyKey: randomUUID(), initiatingSessionId: `session-${f.alice}`, now: f.time() });
    const next = await f.claim();
    expect(await f.authority.tool(next.executionGrant, { toolCallId: "stale_note_recall", tool: "find_saved_summaries", input: {} })).toMatchObject({ output: { items: [] } });
    expect((await f.db.select().from(userSummary))[0].freshness).toBe("stale");
  });

  it("rejects coordinator disablement and revoked grants, tampered tokens and unbound old jobs", async () => {
    const f = await fixture(); await f.submit(); const c = await f.claim();
    await expect(f.authority.context(`${c.executionGrant.slice(0, -1)}X`)).rejects.toMatchObject({ code: "unauthorized" });
    await f.authority.disableCoordinator(f.coordinator.id);
    await expect(f.authority.context(c.executionGrant)).rejects.toMatchObject({ code: "run_not_active" });
    await expect(f.authority.claim(f.bootstrap, { requestId: randomUUID(), workerId: "worker-1" })).rejects.toMatchObject({ code: "unauthorized" });
    expect((await f.db.select().from(chatRun))[0]).toMatchObject({ status: "interrupted", grantsRevokedAt: expect.any(Date) });
    const revoked = await fixture(); await revoked.submit(); const grant = await revoked.claim();
    await revoked.db.update(chatRun).set({ grantsRevokedAt: revoked.time() }).where(eq(chatRun.id, grant.id));
    await expect(revoked.authority.context(grant.executionGrant)).rejects.toMatchObject({ code: "run_not_active" });
    const g = await fixture(); await g.submit(g.alice, "missing-session");
    expect(await g.authority.claim(g.bootstrap, { requestId: randomUUID(), workerId: "worker-1" })).toBeNull();
    expect(await g.authority.reap()).toBe(1);
  });

  it("bounds claim rate and aggregate tool outputs and rejects unknown event fields", async () => {
    const f = await fixture();
    for (let i = 0; i < 6; i++) expect(await f.authority.claim(f.bootstrap, { requestId: randomUUID(), workerId: "worker-1" })).toBeNull();
    await expect(f.authority.claim(f.bootstrap, { requestId: randomUUID(), workerId: "worker-1" })).rejects.toMatchObject({ code: "quota_exceeded" });
    f.advance(60_001); await f.submit(); const c: ClaimReply = await f.claim();
    await expect(f.authority.events(c.executionGrant, { events: [{ ...completion(), data: { answer: "Synthetic", userId: f.bob } }] })).rejects.toMatchObject({ code: "invalid_request" });
    await f.db.update(chatRun).set({ executionMeta: { toolOutputBytes: 192 * 1024 } }).where(eq(chatRun.id, c.id));
    await expect(f.authority.tool(c.executionGrant, { toolCallId: "budget", tool: "get_data_coverage", input: {} })).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(await f.db.select().from(chatToolCall)).toHaveLength(0);
  });
});
