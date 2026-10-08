import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { sealField, userKeysFor } from "@/lib/crypto/user-keys";
import { chatToolCall, fhirAttachment, fhirResource, healthSource, summaryEvidence, userSummary } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { ChatScope } from "./contracts";
import { invokeRecordedChatTool } from "./gateway";
import { claimRun, createConversation, submitQuestionAndRun } from "./store";

let db: Db;
let alice: string;
let bob: string;
let own: string[];
let foreign: string;
let note: string;
let mixedUnit: string;

beforeAll(async () => {
  db = await createTestDb();
  alice = await createTestUser(db, "gateway_alice");
  bob = await createTestUser(db, "gateway_bob");
  own = [];
  for (const person of [alice, bob]) {
    const keys = await userKeysFor(db, Buffer.from(process.env.RECORDS_ENCRYPTION_KEY!, "base64"), person, new Date());
    const [source] = await db.insert(healthSource).values({ userId: person, vendor: "epic", fhirBaseUrl: `https://${person}.example/R4`, organizationName: "Synthetic organization", status: "disconnected", lastSyncStatus: "partial" }).returning();
    for (let index = 0; index < (person === alice ? 3 : 1); index++) {
      const id = randomUUID();
      const unit = index === 2 ? "mg/dL" : "mmol/L";
      const resource = { resourceType: "Observation", code: { text: "Synthetic potassium", coding: [{ system: "http://loinc.org", code: "2823-3" }] }, valueQuantity: { value: 4 + index / 10, unit } };
      const summary = { key: id, category: "lab", title: "Synthetic potassium", detail: `${resource.valueQuantity.value} ${unit}`, status: "final" };
      await db.insert(fhirResource).values({ id, userId: person, sourceId: source.id, resourceType: "Observation", fhirId: id, category: "lab", effectiveAt: new Date(`2026-01-0${index + 1}T00:00:00Z`), contentHmac: id, sealedResource: sealField(keys, JSON.stringify(resource), { table: "fhir_resource", field: "resource", rowId: id }), sealedSummary: sealField(keys, JSON.stringify(summary), { table: "fhir_resource", field: "summary", rowId: id }), normalizerVersion: 2, firstSeenAt: new Date(), lastSeenAt: new Date() });
      if (person === alice) {
        if (index < 2) own.push(id); else mixedUnit = id;
      } else foreign = id;
    }
    if (person === alice) {
      note = randomUUID();
      await db.insert(fhirAttachment).values({ id: note, userId: person, sourceId: source.id, resourceId: own[0], sealedUrl: sealField(keys, "https://synthetic.example/note", { table: "fhir_attachment", field: "url", rowId: note }), urlHmac: note, contentType: "text/plain", sealedText: sealField(keys, "Synthetic private note. ".repeat(1000), { table: "fhir_attachment", field: "text", rowId: note }), fetchedAt: new Date() });
    }
  }
});

async function worker(): Promise<ChatScope> {
  const conversation = await createConversation(db, { userId: alice }, {});
  const submitted = await submitQuestionAndRun(db, { userId: alice, conversationId: conversation.id }, { message: "Synthetic question", idempotencyKey: randomUUID() });
  const scope = { userId: alice, conversationId: conversation.id, runId: submitted.run.id };
  const run = await claimRun(db, scope, { workerId: "synthetic-worker", leaseMs: 120_000 });
  return { ...scope, runAttempt: run!.attempt, workerId: "synthetic-worker" };
}

describe("deterministic health tool acceptance", () => {
  it("saves derived memory using server IDs, replays it once, and rejects injected metadata or foreign evidence", async () => {
    const scope = await worker();
    const rawInput = { title: "Synthetic trend memory", text: "Synthetic potassium trend is available.", coverageState: "partial", evidence: [{ kind: "record", targetId: own[0] }] };
    const call = { providerToolCallId: "memory_1", tool: "save_summary" as const, rawInput };
    await expect(invokeRecordedChatTool(db, scope, { ...call, rawInput: { ...rawInput, idempotencyKey: "sensitive model text" } })).rejects.toThrow();
    await expect(invokeRecordedChatTool(db, scope, { ...call, rawInput: { ...rawInput, evidence: [{ ...rawInput.evidence[0], id: own[0] }] } })).rejects.toThrow();
    await invokeRecordedChatTool(db, scope, { providerToolCallId: "memory_evidence", tool: "read_records", rawInput: { recordIds: [own[0]] } });
    const result = await invokeRecordedChatTool(db, scope, call);
    const summary = result.output as { id: string; content: { evidence: { id: string }[] } };
    const [saved] = await db.select().from(userSummary).where(eq(userSummary.id, summary.id));
    const [trace] = await db.select().from(chatToolCall).where(and(eq(chatToolCall.runId, scope.runId!), eq(chatToolCall.toolName, "save_summary")));
    expect(saved.idempotencyKey).toBe(trace.id);
    const evidence = await db.select().from(summaryEvidence).where(eq(summaryEvidence.summaryId, summary.id));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].id).not.toBe(own[0]);
    expect(summary.content.evidence[0].id).toBe(evidence[0].id);
    expect(await invokeRecordedChatTool(db, scope, call)).toEqual({ status: "replay", output: JSON.parse(JSON.stringify(result.output)) });
    expect(await db.select().from(userSummary).where(eq(userSummary.id, summary.id))).toHaveLength(1);
    await expect(invokeRecordedChatTool(db, scope, { ...call, providerToolCallId: "memory_foreign", rawInput: { ...rawInput, evidence: [{ kind: "record", targetId: foreign }] } })).rejects.toThrow();
  });

  it("reads only owned encrypted records and refuses caller-selected identity fields", async () => {
    const scope = await worker();
    const found = await invokeRecordedChatTool(db, scope, { providerToolCallId: "call_llama_1", tool: "find_records", rawInput: { query: "potassium", limit: 2 } });
    expect(found.output).toMatchObject({ truncated: true, records: [{ citation: { id: own[0] } }, { citation: { id: own[1] } }] });
    const read = await invokeRecordedChatTool(db, scope, { providerToolCallId: "call_llama_2", tool: "read_records", rawInput: { recordIds: [own[0], foreign] } });
    expect(read.output).toHaveLength(1);
    expect(read.output).toMatchObject([{ citation: { id: own[0] }, summary: { title: "Synthetic potassium" } }]);
    await expect(invokeRecordedChatTool(db, scope, { providerToolCallId: "call_llama_3", tool: "find_records", rawInput: { userId: bob } })).rejects.toThrow();
    const raw = await db.select().from(chatToolCall).where(eq(chatToolCall.runId, scope.runId!));
    expect(JSON.stringify(raw)).not.toContain("potassium");
    expect(JSON.stringify(raw)).not.toContain("call_llama_1");
  });

  it("compares compatible observations and refuses mixed units or foreign evidence", async () => {
    const scope = await worker();
    const trend = await invokeRecordedChatTool(db, scope, { providerToolCallId: "trend_1", tool: "calculate_lab_trend", rawInput: { recordIds: own } });
    expect(trend.output).toMatchObject({ ok: true, unit: "mmol/L", points: [{ value: 4 }, { value: 4.1 }] });
    expect((trend.output as { change: number }).change).toBeCloseTo(0.1);
    const mixed = await invokeRecordedChatTool(db, scope, { providerToolCallId: "trend_2", tool: "calculate_lab_trend", rawInput: { recordIds: [own[0], mixedUnit] } });
    expect(mixed.output).toMatchObject({ ok: false });
    const foreignTrend = await invokeRecordedChatTool(db, scope, { providerToolCallId: "trend_3", tool: "calculate_lab_trend", rawInput: { recordIds: [own[0], foreign] } });
    expect(foreignTrend.output).toMatchObject({ ok: false });
  });

  it("bounds stored notes, replays completed calls and enforces the durable call budget", async () => {
    const scope = await worker();
    const input = { providerToolCallId: "note_1", tool: "read_stored_note" as const, rawInput: { attachmentId: note } };
    const first = await invokeRecordedChatTool(db, scope, input);
    expect(first.output).toMatchObject({ available: true, truncated: true });
    expect((first.output as { text: string }).text).toHaveLength(12_000);
    const replay = await invokeRecordedChatTool(db, scope, input);
    expect(replay).toEqual({ status: "replay", output: first.output });
    await expect(invokeRecordedChatTool(db, scope, { ...input, rawInput: { attachmentId: randomUUID() } })).rejects.toThrow();
    for (let index = 2; index <= 6; index++) await invokeRecordedChatTool(db, scope, { providerToolCallId: `coverage_${index}`, tool: "get_data_coverage", rawInput: {} });
    await expect(invokeRecordedChatTool(db, scope, { providerToolCallId: "coverage_7", tool: "get_data_coverage", rawInput: {} })).rejects.toThrow();
    expect(await db.select().from(chatToolCall).where(eq(chatToolCall.runId, scope.runId!))).toHaveLength(6);
  });
});
