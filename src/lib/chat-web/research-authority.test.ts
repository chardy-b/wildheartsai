import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { sealField, unsealField, userKeysFor } from "@/lib/crypto/user-keys";
import { chatCoordinator, chatRun, chatToolCall, fhirAttachment, fhirResource, healthSource, session } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createConversation, requestRunCancellation, submitQuestionAndRun, finishToolCall, listResearchToolPage } from "@/lib/chat/store";
import { ChatAuthority, credentialHash } from "./authority";
import { CHAT_DEADLINE_MS, CHAT_MAX_TOOL_OUTPUT_BYTES, CHAT_MAX_RESEARCH_OUTPUT_BYTES, researchBeginInputSchema, type ResearchOutput, type ResearchBeginInput } from "./protocol";

async function fixture(researchGatewayTokenHash?: string) {
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
  const authority = new ChatAuthority({ dataDb, queueDb, grantKey: Buffer.alloc(32, 9), modelId: "synthetic-model", researchGatewayTokenHash, now: () => time });
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
const credential = Buffer.alloc(32, 6).toString("base64url");
const snapshot = "a".repeat(64); const source = "b".repeat(64);
const passage = (excerpt = "Synthetic research excerpt") => ({ sourceId: source, title: "Synthetic research title", path: "studies/synthetic.md", startLine: 1, endLine: 1, excerpt, offset: 0, nextOffset: null, totalChars: Array.from(excerpt).length, truncated: false });
const output = (excerpt?: string): ResearchOutput => ({ snapshotId: snapshot, hits: [passage(excerpt)], truncated: false });
const command = (toolCallId = "research_one", query = "Synthetic research query", proposedSnapshotId = snapshot) => researchBeginInputSchema.parse({ toolCallId, tool: "search_research", input: { query }, proposedSnapshotId }) as Extract<ResearchBeginInput, { tool: "search_research" }>;
async function ready() { const f = await fixture(credentialHash(credential)); await f.submit(); return { ...f, c: await f.claim() }; }
const completion = () => ({ eventId: randomUUID(), sequence: 1, type: "completed" as const, data: { answer: "Synthetic complete answer" } });

describe("offline research authority and encrypted trace", () => {
  it("requires both credentials while missing/malformed research config leaves ordinary chat usable", async () => {
    for (const verifier of [undefined, "not-a-hash"]) {
      const f = await fixture(verifier); await f.submit(); const c = await f.claim();
      await expect(f.authority.researchBegin(c.executionGrant, credential, command())).rejects.toMatchObject({ code: "unauthorized" });
      expect(await f.authority.tool(c.executionGrant, { toolCallId: "coverage", tool: "get_data_coverage", input: {} })).toHaveProperty("output");
    }
    const f = await ready();
    for (const value of ["", Buffer.alloc(32, 5).toString("base64url"), f.bootstrap]) await expect(f.authority.researchBegin(f.c.executionGrant, value, command())).rejects.toMatchObject({ code: "unauthorized" });
    await expect(f.authority.researchBegin(f.c.controlGrant, credential, command())).rejects.toMatchObject({ code: "unauthorized" });
    expect(await f.db.select().from(chatToolCall)).toHaveLength(0);
  });

  it("pins the first snapshot and recovers pending calls without accepting changed arguments or caller scope", async () => {
    const f = await ready(); const input = command();
    const begun = await f.authority.researchBegin(f.c.executionGrant, credential, input);
    expect(begun).toMatchObject({ status: "execute", snapshotId: snapshot, deadlineAt: f.c.deadlineAt });
    expect(await f.authority.researchBegin(f.c.executionGrant, credential, input)).toEqual(begun);
    for (const changed of [command(input.toolCallId, "Changed query"), command("second", "Synthetic", "c".repeat(64))]) await expect(f.authority.researchBegin(f.c.executionGrant, credential, changed)).rejects.toMatchObject({ code: "invalid_request", status: 409 });
    await expect(f.authority.researchBegin(f.c.executionGrant, credential, { ...input, userId: f.bob } as unknown as typeof input)).rejects.toMatchObject({ code: "invalid_request" });
    expect((await f.db.select().from(chatRun))[0].executionMeta).toEqual({ researchSnapshotId: snapshot });
    expect(await f.db.select().from(chatToolCall)).toHaveLength(1);
  });

  it("seals query/source/snapshot, keeps receipts empty, and acknowledges exact immutable result retries without rebilling", async () => {
    const f = await ready(); const input = command(); const begun = await f.authority.researchBegin(f.c.executionGrant, credential, input);
    const result = { operationId: begun.operationId, status: "completed" as const, output: output() };
    expect(await f.authority.researchResult(f.c.executionGrant, credential, result)).toEqual({ status: "accepted" });
    const used = (await f.db.select().from(chatRun))[0].executionMeta.toolOutputBytes;
    expect(used).toBe(Buffer.byteLength(JSON.stringify(result.output)));
    expect(await f.authority.researchResult(f.c.executionGrant, credential, result)).toEqual({ status: "duplicate" });
    expect(await f.authority.researchBegin(f.c.executionGrant, credential, input)).toEqual({ status: "completed", operationId: begun.operationId, output: result.output });
    await expect(f.authority.researchResult(f.c.executionGrant, credential, { ...result, output: output("Changed excerpt") })).rejects.toMatchObject({ code: "invalid_request", status: 409 });
    await expect(f.authority.researchResult(f.c.executionGrant, credential, { operationId: begun.operationId, status: "failed", errorCode: "research_failed" })).rejects.toMatchObject({ code: "invalid_request", status: 409 });
    expect((await f.db.select().from(chatRun))[0].executionMeta.toolOutputBytes).toBe(used);
    const [call] = await f.db.select().from(chatToolCall); const persisted = JSON.stringify(call);
    for (const value of [input.input.query, snapshot, "studies/synthetic.md", "Synthetic research excerpt", credential]) expect(persisted).not.toContain(value);
    const keys = await userKeysFor(f.db, Buffer.from(process.env.RECORDS_ENCRYPTION_KEY!, "base64"), f.alice, f.time());
    const context = JSON.parse(unsealField(keys, call.sealedContext!, { table: "chat_tool_call", field: "context", rowId: call.id }));
    expect(context).toMatchObject({ readEvidence: [], research: { snapshotId: snapshot, attempt: f.c.attempt, completionDigest: expect.any(String) } });
    expect(await f.dataDb.transaction(tx => tx.select().from(chatToolCall))).toEqual([]);
  });

  it("counts failed reservations once in the same six-call budget as patient tools", async () => {
    const f = await ready();
    for (let index = 0; index < 6; index++) {
      const input = command(`failed_${index}`); const begin = await f.authority.researchBegin(f.c.executionGrant, credential, input);
      const failed = { operationId: begin.operationId, status: "failed" as const, errorCode: "snapshot_unavailable" as const };
      expect(await f.authority.researchResult(f.c.executionGrant, credential, failed)).toEqual({ status: "accepted" });
      expect(await f.authority.researchResult(f.c.executionGrant, credential, failed)).toEqual({ status: "duplicate" });
      expect(await f.authority.researchBegin(f.c.executionGrant, credential, input)).toEqual({ status: "failed", operationId: begin.operationId, errorCode: "snapshot_unavailable" });
    }
    await expect(f.authority.researchBegin(f.c.executionGrant, credential, command("seventh"))).rejects.toMatchObject({ code: "quota_exceeded" });
    await expect(f.authority.tool(f.c.executionGrant, { toolCallId: "health_seventh", tool: "get_data_coverage", input: {} })).rejects.toThrow("limit reached");
    expect(await f.db.select().from(chatToolCall)).toHaveLength(6);
  });

  it("binds reads to source/snapshot/Unicode code-point offset and limit", async () => {
    const f = await ready();
    const input = researchBeginInputSchema.parse({ toolCallId: "read_one", tool: "read_research", input: { snapshotId: snapshot, sourceId: source, offset: 10, limit: 3 }, proposedSnapshotId: snapshot });
    await expect(f.authority.researchBegin(f.c.executionGrant, credential, { ...input, proposedSnapshotId: "c".repeat(64) })).rejects.toMatchObject({ code: "invalid_request" });
    const begin = await f.authority.researchBegin(f.c.executionGrant, credential, input);
    const read = { ...passage("A\u{1f600}B"), snapshotId: snapshot, offset: 10, totalChars: 13, truncated: true };
    for (const changed of [{ ...read, sourceId: "d".repeat(64) }, { ...read, snapshotId: "c".repeat(64) }, { ...read, excerpt: "ABCD", totalChars: 14 }]) await expect(f.authority.researchResult(f.c.executionGrant, credential, { operationId: begin.operationId, status: "completed", output: changed })).rejects.toMatchObject({ code: "invalid_request" });
    expect(await f.authority.researchResult(f.c.executionGrant, credential, { operationId: begin.operationId, status: "completed", output: read })).toEqual({ status: "accepted" });
  });

  it("rejects worker-forged receipts, ordinary health result IDs and research-backed patient summaries", async () => {
    const f = await ready(); const recordId = await f.record(f.alice);
    const begin = await f.authority.researchBegin(f.c.executionGrant, credential, command());
    const result = { operationId: begin.operationId, status: "completed" as const, output: output() };
    await expect(f.authority.researchResult(f.c.executionGrant, "", result)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(f.authority.researchResult(f.c.executionGrant, credential, { ...result, readEvidence: [{ kind: "record", targetId: recordId, version: "fake" }] } as typeof result)).rejects.toMatchObject({ code: "invalid_request" });
    await f.authority.researchResult(f.c.executionGrant, credential, result);
    await expect(finishToolCall(f.dataDb, { userId: f.alice, conversationId: f.conversations.get(f.alice)!, runId: f.c.id, runAttempt: f.c.attempt, workerId: f.c.leaseOwner }, { toolCallId: begin.operationId, status: "completed", result: {}, readEvidence: [{ kind: "record", targetId: recordId, version: "fake" }] })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.authority.tool(f.c.executionGrant, { toolCallId: "unsupported_summary", tool: "save_summary", input: { title: "Synthetic", text: "Derived", coverageState: "unknown", evidence: [{ kind: "record", targetId: recordId }] } })).rejects.toThrow("not read");
    await f.authority.tool(f.c.executionGrant, { toolCallId: "coverage", tool: "get_data_coverage", input: {} });
    const call = (await f.db.select().from(chatToolCall)).find(row => row.toolName === "get_data_coverage")!;
    await expect(f.authority.researchResult(f.c.executionGrant, credential, { ...result, operationId: call.id })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rolls back result persistence for serialized-byte and aggregate-output cap failures", async () => {
    const f = await ready(); const begin = await f.authority.researchBegin(f.c.executionGrant, credential, command());
    const large = output("\u6f22".repeat(12_000));
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(CHAT_MAX_RESEARCH_OUTPUT_BYTES);
    await expect(f.authority.researchResult(f.c.executionGrant, credential, { operationId: begin.operationId, status: "completed", output: large })).rejects.toMatchObject({ code: "quota_exceeded" });
    await f.db.update(chatRun).set({ executionMeta: { researchSnapshotId: snapshot, toolOutputBytes: CHAT_MAX_TOOL_OUTPUT_BYTES - 1 } }).where(eq(chatRun.id, f.c.id));
    await expect(f.authority.researchResult(f.c.executionGrant, credential, { operationId: begin.operationId, status: "completed", output: output() })).rejects.toMatchObject({ code: "quota_exceeded" });
    expect((await f.db.select().from(chatToolCall))[0]).toMatchObject({ status: "pending", sealedResult: null });
  });

  it("denies logout/expired/stale attempts and reaps pending work while preserving completed results", async () => {
    for (const cause of ["logout", "expired", "attempt"] as const) {
      const f = await ready(); const first = await f.authority.researchBegin(f.c.executionGrant, credential, command("done"));
      await f.authority.researchResult(f.c.executionGrant, credential, { operationId: first.operationId, status: "completed", output: output() });
      const pending = await f.authority.researchBegin(f.c.executionGrant, credential, command("pending"));
      if (cause === "logout") await f.db.delete(session).where(eq(session.id, `session-${f.alice}`));
      if (cause === "expired") f.advance(30_001);
      if (cause === "attempt") await f.db.update(chatRun).set({ attempt: f.c.attempt + 1 }).where(eq(chatRun.id, f.c.id));
      await expect(f.authority.researchResult(f.c.executionGrant, credential, { operationId: pending.operationId, status: "completed", output: output() })).rejects.toMatchObject({ code: "run_not_active" });
      f.advance(30_001); expect(await f.authority.reap()).toBe(1);
      const calls = await f.db.select().from(chatToolCall); expect(calls.find(call => call.id === first.operationId)?.status).toBe("completed"); expect(calls.find(call => call.id === pending.operationId)?.status).toBe("failed");
    }
  });

  it("closes pending calls on cancellation, coordinator disablement and worker/control termination", async () => {
    for (const action of ["cancel", "disable", "complete", "control"] as const) {
      const f = await ready(); const begin = await f.authority.researchBegin(f.c.executionGrant, credential, command());
      if (action === "cancel") await requestRunCancellation(f.dataDb, { userId: f.alice, conversationId: f.conversations.get(f.alice)!, runId: f.c.id });
      if (action === "disable") await f.authority.disableCoordinator(f.coordinator.id);
      if (action === "complete") await f.authority.events(f.c.executionGrant, { events: [completion()] });
      if (action === "control") await f.authority.finalize(f.c.controlGrant, { requestId: randomUUID(), status: "interrupted" });
      await expect(f.authority.researchResult(f.c.executionGrant, credential, { operationId: begin.operationId, status: "completed", output: output() })).rejects.toMatchObject({ code: "run_not_active" });
      expect((await f.db.select().from(chatToolCall))[0]).toMatchObject({ status: action === "cancel" ? "cancelled" : "failed", completedAt: expect.any(Date) });
    }
  });

  it("pages only owned completed research with positive cursors and no query/provider/receipt disclosures", async () => {
    const f = await ready(); await f.authority.tool(f.c.executionGrant, { toolCallId: "health", tool: "get_data_coverage", input: {} });
    for (const id of ["one", "two"]) { const begin = await f.authority.researchBegin(f.c.executionGrant, credential, command(id)); await f.authority.researchResult(f.c.executionGrant, credential, { operationId: begin.operationId, status: "completed", output: output() }); }
    const pending = await f.authority.researchBegin(f.c.executionGrant, credential, command("pending"));
    const scope = { userId: f.alice, conversationId: f.conversations.get(f.alice)!, runId: f.c.id };
    expect(await listResearchToolPage(f.dataDb, scope)).toEqual({ calls: [{ callOrder: 2, tool: "search_research", output: output() }], hasMore: true, nextAfter: 2 });
    const next = await listResearchToolPage(f.dataDb, scope, { after: 2 });
    expect(next).toEqual({ calls: [{ callOrder: 3, tool: "search_research", output: output() }], hasMore: false, nextAfter: null });
    for (const value of ["query", "readEvidence", pending.operationId]) expect(JSON.stringify(next)).not.toContain(value);
    await expect(listResearchToolPage(f.dataDb, { ...scope, userId: f.bob })).rejects.toThrow("not found");
    for (const after of [0, -1, 1.5, 7]) await expect(listResearchToolPage(f.dataDb, scope, { after })).rejects.toMatchObject({ code: "CHAT_INVALID_CURSOR" });
    await expect(listResearchToolPage(f.dataDb, scope, { limit: 3 })).rejects.toMatchObject({ code: "CHAT_INVALID_CURSOR" });
    await expect(listResearchToolPage(f.dataDb, { userId: f.bob, conversationId: f.conversations.get(f.bob)!, runId: randomUUID() })).rejects.toThrow("not found");
  });
  it("reserves new searches against the authoritative old snapshot after a gateway restart and records missing-snapshot failures", async () => {
    const f = await ready(); const first = await f.authority.researchBegin(f.c.executionGrant, credential, command("first"));
    await f.authority.researchResult(f.c.executionGrant, credential, { operationId: first.operationId, status: "completed", output: output() });
    const proposal = command("after_restart", "Synthetic", "c".repeat(64));
    const second = await f.authority.researchBegin(f.c.executionGrant, credential, proposal);
    expect(second).toMatchObject({ status: "execute", snapshotId: snapshot });
    await expect(f.authority.researchBegin(f.c.executionGrant, credential, { ...proposal, proposedSnapshotId: snapshot })).rejects.toMatchObject({ code: "invalid_request", status: 409 });
    await expect(f.authority.researchResult(f.c.executionGrant, credential, { operationId: second.operationId, status: "completed", output: { ...output(), snapshotId: "c".repeat(64) } })).rejects.toMatchObject({ code: "invalid_request" });
    await f.authority.researchResult(f.c.executionGrant, credential, { operationId: second.operationId, status: "failed", errorCode: "snapshot_unavailable" });
    expect((await f.db.select().from(chatRun))[0].executionMeta.researchSnapshotId).toBe(snapshot);
    await expect(f.authority.researchBegin(f.c.executionGrant, credential, researchBeginInputSchema.parse({ toolCallId: "read_new", tool: "read_research", proposedSnapshotId: "c".repeat(64), input: { snapshotId: "c".repeat(64), sourceId: source } }))).rejects.toMatchObject({ code: "invalid_request", status: 409 });
  });

  it("reserves the existing run pin when a restarted gateway cannot capture the current corpus", async () => {
    const f = await ready();
    const first = await f.authority.researchBegin(f.c.executionGrant, credential, command("first_pin"));
    await f.authority.researchResult(f.c.executionGrant, credential, { operationId: first.operationId, status: "completed", output: output() });
    const input = researchBeginInputSchema.parse({ toolCallId: "capture_failed_after_restart", tool: "search_research", input: { query: "Synthetic" }, proposedSnapshotId: null, failureCode: "research_unavailable" });
    const begin = await f.authority.researchBegin(f.c.executionGrant, credential, input);
    expect(begin).toMatchObject({ status: "execute", snapshotId: snapshot });
    expect(await f.authority.researchBegin(f.c.executionGrant, credential, input)).toEqual(begin);
    expect((await f.db.select().from(chatToolCall)).find(call => call.id === begin.operationId)).toMatchObject({ status: "pending", sealedResult: null });
    await f.authority.researchResult(f.c.executionGrant, credential, { operationId: begin.operationId, status: "failed", errorCode: "snapshot_unavailable" });
    expect(await f.authority.researchBegin(f.c.executionGrant, credential, input)).toMatchObject({ status: "failed", operationId: begin.operationId, errorCode: "snapshot_unavailable" });
    expect((await f.db.select().from(chatRun))[0].executionMeta.researchSnapshotId).toBe(snapshot);
    expect(await f.db.select().from(chatToolCall)).toHaveLength(2);
  });

  it("rolls back protected work if the fixed deadline or initiating session expires during the operation", async () => {
    for (const cause of ["deadline", "session"] as const) {
      const f = await ready(); const begin = await f.authority.researchBegin(f.c.executionGrant, credential, command());
      const delta = cause === "deadline" ? CHAT_DEADLINE_MS + 1 : 2_000;
      if (cause === "session") await f.db.update(session).set({ expiresAt: new Date(f.time().getTime() + 1_000) }).where(eq(session.id, `session-${f.alice}`));
      let reads = 0;
      const authority = new ChatAuthority({ dataDb: f.dataDb, queueDb: f.queueDb, grantKey: Buffer.alloc(32, 9), modelId: "synthetic-model", researchGatewayTokenHash: credentialHash(credential), now: () => new Date(f.time().getTime() + (++reads >= 4 ? delta : 0)) });
      await expect(authority.researchResult(f.c.executionGrant, credential, { operationId: begin.operationId, status: "completed", output: output() })).rejects.toMatchObject({ code: "run_not_active" });
      expect((await f.db.select().from(chatToolCall))[0]).toMatchObject({ status: "pending", sealedResult: null });
      expect((await f.db.select().from(chatRun))[0].executionMeta.toolOutputBytes).toBeUndefined();
    }
  });

  it("rejects a foreign run operation ID and bounds stored viewer outputs even for malformed legacy rows", async () => {
    const f = await ready(); const first = await f.authority.researchBegin(f.c.executionGrant, credential, command());
    await f.authority.researchResult(f.c.executionGrant, credential, { operationId: first.operationId, status: "completed", output: output() });
    await f.authority.events(f.c.executionGrant, { events: [completion()] });
    await f.submit(f.bob); const bob = await f.claim();
    await expect(f.authority.researchResult(bob.executionGrant, credential, { operationId: first.operationId, status: "completed", output: output() })).rejects.toMatchObject({ code: "invalid_request" });
    const keys = await userKeysFor(f.db, Buffer.from(process.env.RECORDS_ENCRYPTION_KEY!, "base64"), f.alice, f.time());
    await f.db.update(chatToolCall).set({ sealedResult: sealField(keys, JSON.stringify(output("\u6f22".repeat(12_000))), { table: "chat_tool_call", field: "result", rowId: first.operationId }) }).where(eq(chatToolCall.id, first.operationId));
    await expect(listResearchToolPage(f.dataDb, { userId: f.alice, conversationId: f.conversations.get(f.alice)!, runId: f.c.id })).rejects.toMatchObject({ code: "CHAT_PAGE_TOO_LARGE" });
  });

  it("records unavailable initial captures without a sentinel pin or repeated budget consumption", async () => {
    const f = await ready(); const input = researchBeginInputSchema.parse({ toolCallId: "unavailable", tool: "search_research", input: { query: "Synthetic" }, proposedSnapshotId: null, failureCode: "research_unavailable" });
    const first = await f.authority.researchBegin(f.c.executionGrant, credential, input);
    expect(first).toMatchObject({ status: "failed", errorCode: "research_unavailable" });
    expect(await f.authority.researchBegin(f.c.executionGrant, credential, input)).toEqual(first);
    expect(await f.authority.researchResult(f.c.executionGrant, credential, { operationId: first.operationId, status: "failed", errorCode: "research_unavailable" })).toEqual({ status: "duplicate" });
    expect((await f.db.select().from(chatRun))[0].executionMeta).not.toHaveProperty("researchSnapshotId");
    expect(await f.db.select().from(chatToolCall)).toHaveLength(1);
    await expect(f.authority.researchBegin(f.c.executionGrant, credential, command("unavailable", "Synthetic"))).rejects.toMatchObject({ code: "invalid_request" });
    const available = await f.authority.researchBegin(f.c.executionGrant, credential, command("now_available"));
    expect(available).toMatchObject({ status: "execute", snapshotId: snapshot });
    expect(await f.authority.researchBegin(f.c.executionGrant, credential, input)).toEqual(first);
    expect(await f.authority.researchResult(f.c.executionGrant, credential, { operationId: first.operationId, status: "failed", errorCode: "research_unavailable" })).toEqual({ status: "duplicate" });
  });

  it("keeps a two-call source page below 64 KiB without skipping a near-cap second result", async () => {
    const f = await ready();
    let count = 5_500;
    while (Buffer.byteLength(JSON.stringify(output("\u0001".repeat(count)))) > CHAT_MAX_RESEARCH_OUTPUT_BYTES) count--;
    const large = output("\u0001".repeat(count));
    for (const id of ["large_one", "large_two"]) { const begin = await f.authority.researchBegin(f.c.executionGrant, credential, command(id)); await f.authority.researchResult(f.c.executionGrant, credential, { operationId: begin.operationId, status: "completed", output: large }); }
    const scope = { userId: f.alice, conversationId: f.conversations.get(f.alice)!, runId: f.c.id };
    const page = await listResearchToolPage(f.dataDb, scope, { limit: 2 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
    expect(page).toMatchObject({ calls: [{ callOrder: 1 }], hasMore: true, nextAfter: 1 });
    expect(page.calls).toHaveLength(1);
    expect(await listResearchToolPage(f.dataDb, scope, { after: page.nextAfter!, limit: 2 })).toMatchObject({ calls: [{ callOrder: 2 }], hasMore: false, nextAfter: null });
  });

});
