import "server-only";
import { and, asc, count, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { unsealField, userKeysFor } from "@/lib/crypto/user-keys";
import { fhirAttachment, fhirResource, healthSource } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import type { Db } from "@/lib/db/types";
import { describeResource } from "@/lib/fhir/describe";
import type { Observation } from "@/lib/fhir/types";
import { openStoredRow } from "@/lib/sync/store";
import type { ChatScope } from "./contracts";
import { chatRecordsKey } from "./key";
import { assertActiveWorker, beginRecordedToolCall, finishToolCall, isCancellationRequested, listSummaries, saveSummary, noteReadVersion, type ReadReceipt } from "./store";
import { CHAT_MAX_CANDIDATES, CHAT_MAX_NOTE_CHARS, chatToolSchemas, type ChatToolName } from "./tools";

const evidenceReceipts = new WeakMap<object, ReadReceipt[]>();
function withReceipts<T extends object>(output: T, receipts: ReadReceipt[]): T { evidenceReceipts.set(output, receipts); return output; }

type Citation = { kind: "record" | "note"; id: string };
const current = [isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt)];

async function keysFor(tx: Db, userId: string) {
  return userKeysFor(tx, chatRecordsKey(), userId, new Date());
}

export async function executeChatTool<T extends ChatToolName>(
  db: Db,
  scope: ChatScope,
  name: T,
  rawInput: unknown,
  trusted: { summaryIdempotencyKey?: string } = {},
): Promise<unknown> {
  const input = chatToolSchemas[name].parse(rawInput) as never;
  await assertActiveWorker(db, scope);
  if (await isCancellationRequested(db, scope)) throw new Error("Chat run was cancelled");
  switch (name) {
    case "get_data_coverage":
      return getDataCoverage(db, scope);
    case "find_records":
      return findRecords(db, scope, input as z.infer<typeof chatToolSchemas.find_records>);
    case "read_records":
      return readRecords(db, scope, input as z.infer<typeof chatToolSchemas.read_records>);
    case "read_stored_note":
      return readStoredNote(db, scope, input as z.infer<typeof chatToolSchemas.read_stored_note>);
    case "calculate_lab_trend":
      return calculateLabTrend(db, scope, input as z.infer<typeof chatToolSchemas.calculate_lab_trend>);
    case "find_saved_summaries":
      return findSavedSummaries(db, scope, input as z.infer<typeof chatToolSchemas.find_saved_summaries>);
    case "save_summary":
      if (!trusted.summaryIdempotencyKey) throw new Error("Summary requires a recorded tool call");
      return savePersonalSummary(db, scope, input as z.infer<typeof chatToolSchemas.save_summary>, trusted.summaryIdempotencyKey);
  }
}

// This is the only durable execution entrypoint for provider tool calls. It gives retries a
// sealed completed result and prevents a provider from bypassing the per-run budget/call order.
export async function invokeRecordedChatTool<T extends ChatToolName>(
  db: Db,
  scope: ChatScope,
  input: { providerToolCallId: string; tool: T; rawInput: unknown },
): Promise<{ status: "completed" | "replay"; output: unknown }> {
  const parsed = chatToolSchemas[input.tool].parse(input.rawInput) as unknown;
  const begun = await beginRecordedToolCall(db, scope, { providerToolCallId: input.providerToolCallId, toolName: input.tool, arguments: parsed });
  if (begun.status === "replay") return { status: "replay", output: begun.result };
  if (begun.status === "pending") throw new Error("Tool call is already pending");
  try {
    const output = await executeChatTool(db, scope, input.tool, parsed, { summaryIdempotencyKey: begun.toolCallId });
    const finished = await finishToolCall(db, scope, { toolCallId: begun.toolCallId, status: "completed", result: output, readEvidence: output && typeof output === "object" ? evidenceReceipts.get(output) : undefined });
    if (!finished) throw new Error("Chat worker lease is no longer active");
    return { status: "completed", output };
  } catch (error) {
    await finishToolCall(db, scope, { toolCallId: begun.toolCallId, status: "failed" }).catch(() => false);
    throw error;
  }
}

// Importing z only for inferred validator types keeps executable validation canonical in tools.ts.
import { z } from "zod";

export async function getDataCoverage(db: Db, scope: ChatScope) {
  return asUser(db, scope.userId, async (tx) => {
    const [sources, counts] = await Promise.all([
      tx.select({ id: healthSource.id, status: healthSource.status, lastSyncedAt: healthSource.lastSyncedAt, lastSyncStatus: healthSource.lastSyncStatus }).from(healthSource).where(eq(healthSource.userId, scope.userId)),
      tx.select({ category: fhirResource.category, total: count() }).from(fhirResource).where(and(eq(fhirResource.userId, scope.userId), ...current, isNotNull(fhirResource.category))).groupBy(fhirResource.category),
    ]);
    return { sources, categories: counts.filter((row) => row.category).map((row) => ({ category: row.category, count: row.total })), coverage: sources.some((s) => s.lastSyncStatus === "partial" || s.lastSyncStatus === "failed") ? "partial" : sources.length ? "unknown" : "none" };
  });
}

export async function findRecords(db: Db, scope: ChatScope, input: z.infer<typeof chatToolSchemas.find_records>) {
  return asUser(db, scope.userId, async (tx) => {
    const keys = await keysFor(tx, scope.userId);
    const conditions = [eq(fhirResource.userId, scope.userId), ...current, isNotNull(fhirResource.category)];
    if (input.categories?.length) conditions.push(inArray(fhirResource.category, input.categories));
    if (input.resourceTypes?.length) conditions.push(inArray(fhirResource.resourceType, input.resourceTypes));
    if (input.sourceIds?.length) conditions.push(inArray(fhirResource.sourceId, input.sourceIds));
    if (input.from) conditions.push(gte(fhirResource.effectiveAt, new Date(`${input.from}T00:00:00Z`)));
    if (input.to) conditions.push(lt(fhirResource.effectiveAt, new Date(`${input.to}T00:00:00Z`)));
    const rows = await tx.select().from(fhirResource).where(and(...conditions)).orderBy(asc(fhirResource.effectiveAt)).limit(CHAT_MAX_CANDIDATES);
    const query = input.query?.toLocaleLowerCase();
    const matched = rows.flatMap((row) => {
      const opened = openStoredRow(keys, row);
      const haystack = `${opened.summary.title} ${opened.summary.detail ?? ""} ${opened.summary.status ?? ""}`.toLocaleLowerCase();
      if (query && !haystack.includes(query)) return [];
      return [{ citation: { kind: "record" as const, id: row.id }, resourceType: row.resourceType, date: row.effectiveAt?.toISOString() ?? null, title: opened.summary.title, detail: opened.summary.detail, status: opened.summary.status }];
    });
    const records = matched.slice(0, input.limit);
    return withReceipts({ records, truncated: rows.length === CHAT_MAX_CANDIDATES || matched.length > input.limit }, rows.filter(row => records.some(record => record.citation.id === row.id)).map(row => ({ kind: "record", targetId: row.id, version: row.contentHmac })));
  });
}

export async function readRecords(db: Db, scope: ChatScope, input: z.infer<typeof chatToolSchemas.read_records>) {
  return asUser(db, scope.userId, async (tx) => {
    const keys = await keysFor(tx, scope.userId);
    const rows = await tx.select().from(fhirResource).where(and(eq(fhirResource.userId, scope.userId), inArray(fhirResource.id, input.recordIds), ...current));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const result = input.recordIds.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      const opened = openStoredRow(keys, row);
      return [{ citation: { kind: "record" as const, id }, resourceType: row.resourceType, summary: opened.summary, details: input.includeDetails ? describeResource(opened.resource) : undefined }];
    });
    return withReceipts(result, rows.map(row => ({ kind: "record", targetId: row.id, version: row.contentHmac })));
  });
}

export async function readStoredNote(db: Db, scope: ChatScope, input: z.infer<typeof chatToolSchemas.read_stored_note>) {
  return asUser(db, scope.userId, async (tx) => {
    const keys = await keysFor(tx, scope.userId);
    const [row] = await tx.select().from(fhirAttachment).where(and(eq(fhirAttachment.id, input.attachmentId), eq(fhirAttachment.userId, scope.userId))).limit(1);
    if (!row) return { available: false, reason: "not_found" };
    if (!row.sealedText) return { available: false, reason: "not_stored_as_text" };
    const text = JSON.parse(JSON.stringify(unsealField(keys, row.sealedText, { table: "fhir_attachment", field: "text", rowId: row.id }))) as string;
    return withReceipts({ available: true, citation: { kind: "note" as const, id: row.id }, text: text.slice(0, CHAT_MAX_NOTE_CHARS), truncated: text.length > CHAT_MAX_NOTE_CHARS }, [{ kind: "note", targetId: row.id, version: noteReadVersion(keys, row.sealedText) }]);
  });
}

export async function calculateLabTrend(db: Db, scope: ChatScope, input: z.infer<typeof chatToolSchemas.calculate_lab_trend>) {
  const records = (await readRecords(db, scope, { recordIds: input.recordIds, includeDetails: false })) as { citation: Citation; resourceType: string; summary: unknown }[];
  return asUser(db, scope.userId, async (tx) => {
    const keys = await keysFor(tx, scope.userId);
    const rows = await tx.select().from(fhirResource).where(and(eq(fhirResource.userId, scope.userId), inArray(fhirResource.id, records.map((r) => r.citation.id)), ...current));
    const points = rows.map((row) => ({ row, resource: openStoredRow(keys, row).resource as Observation }));
    if (points.length !== input.recordIds.length || points.some((p) => p.resource.resourceType !== "Observation" || p.resource.valueQuantity?.value === undefined)) return { ok: false, reason: "Records must be current quantitative observations" };
    const label = (observation: Observation) => observation.code?.coding?.find((c) => c.system && c.code) ? `${observation.code.coding!.find((c) => c.system && c.code)!.system}|${observation.code.coding!.find((c) => c.system && c.code)!.code}` : observation.code?.text ?? "";
    const first = points[0].resource;
    const expectedLabel = label(first);
    const unit = first.valueQuantity?.unit ?? "";
    if (!expectedLabel || points.some((p) => label(p.resource) !== expectedLabel || (p.resource.valueQuantity?.unit ?? "") !== unit || !p.row.effectiveAt)) return { ok: false, reason: "Records must be the same test with the same unit and dates" };
    const ordered = points.sort((a, b) => a.row.effectiveAt!.getTime() - b.row.effectiveAt!.getTime()).map((p) => ({ citation: { kind: "record" as const, id: p.row.id }, at: p.row.effectiveAt!.toISOString(), value: p.resource.valueQuantity!.value!, unit }));
    return withReceipts({ ok: true, test: first.code?.text ?? expectedLabel, unit, points: ordered, change: ordered[ordered.length - 1].value - ordered[0].value }, rows.map(row => ({ kind: "record", targetId: row.id, version: row.contentHmac })));
  });
}

export async function findSavedSummaries(db: Db, scope: ChatScope, input: z.infer<typeof chatToolSchemas.find_saved_summaries>) {
  const query = input.query?.toLocaleLowerCase();
  return (await listSummaries(db, scope, true)).filter((summary) => !query || `${summary.title} ${summary.content.text}`.toLocaleLowerCase().includes(query)).slice(0, input.limit);
}

export async function savePersonalSummary(
  db: Db,
  scope: ChatScope,
  input: z.infer<typeof chatToolSchemas.save_summary>,
  summaryIdempotencyKey: string,
) {
  return saveSummary(db, scope, {
    idempotencyKey: summaryIdempotencyKey,
    title: input.title,
    text: input.text,
    coverageState: input.coverageState,
    evidence: input.evidence,
  });
}
