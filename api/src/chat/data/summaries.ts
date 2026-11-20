import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { summaryContentSchema, type SummaryContent } from "@/lib/chat/contracts";
import type { Receipt } from "../../data/chat-records";
import * as chat from "../../db/chat/schema";
import type { ChatBindings } from "../env";

// Saved summaries (CHAT_DB): a person's, across conversations. Freshness isn't stored: a summary
// is fresh while every piece of its evidence is still at the version it was read at, which the
// records RPC answers on each read.

export type SummaryView = { id: string; title: string; content: SummaryContent; freshness: "fresh" | "stale"; createdAt: Date; updatedAt: Date };
export const chatDb = (env: ChatBindings) => drizzle(env.CHAT_DB, { schema: chat });

async function withFreshness(env: ChatBindings, recordsUserId: string, rows: (typeof chat.userSummary.$inferSelect)[]): Promise<SummaryView[]> {
  if (!rows.length) return [];
  const evidence = await chatDb(env).select().from(chat.summaryEvidence).where(inArray(chat.summaryEvidence.summaryId, rows.map((r) => r.id)));
  const states = evidence.length ? await env.RECORDS.evidence(recordsUserId, evidence.map((e) => ({ kind: e.kind, targetId: e.targetId }))) : [];
  return rows.map((row) => {
    const own = evidence.filter((e) => e.summaryId === row.id);
    const stale = !own.length || own.some((e) => states.find((s) => s.kind === e.kind && s.targetId === e.targetId)?.version !== e.version);
    return { id: row.id, title: row.title, content: summaryContentSchema.parse(row.content), freshness: stale ? "stale" : "fresh", createdAt: row.createdAt, updatedAt: row.updatedAt };
  });
}

export async function summaryPage(env: ChatBindings, ownerId: string, recordsUserId: string, cursor?: string) {
  const db = chatDb(env);
  const owned = and(eq(chat.userSummary.ownerId, ownerId), isNull(chat.userSummary.deletedAt));
  let before;
  if (cursor) {
    const [row] = await db.select().from(chat.userSummary).where(and(eq(chat.userSummary.ownerId, ownerId), eq(chat.userSummary.id, cursor)));
    if (!row) return null;
    before = or(lt(chat.userSummary.createdAt, row.createdAt), and(eq(chat.userSummary.createdAt, row.createdAt), lt(chat.userSummary.id, row.id)));
  }
  const rows = await db.select().from(chat.userSummary).where(and(owned, before)).orderBy(desc(chat.userSummary.createdAt), desc(chat.userSummary.id)).limit(33);
  const page = rows.slice(0, 32);
  return { summaries: await withFreshness(env, recordsUserId, page), hasMore: rows.length > 32, nextCursor: rows.length > 32 ? page.at(-1)!.id : null };
}

// What find_saved_summaries offers the model: the person's fresh summaries, optionally matching a query.
export async function recallSummaries(env: ChatBindings, ownerId: string, recordsUserId: string, query: string | undefined, limit: number) {
  const rows = await chatDb(env).select().from(chat.userSummary).where(and(eq(chat.userSummary.ownerId, ownerId), isNull(chat.userSummary.deletedAt))).orderBy(desc(chat.userSummary.updatedAt)).limit(100);
  const q = query?.toLocaleLowerCase();
  return (await withFreshness(env, recordsUserId, rows)).filter((s) => s.freshness === "fresh" && (!q || `${s.title} ${s.content.text}`.toLocaleLowerCase().includes(q))).slice(0, limit);
}

export async function deleteSummary(env: ChatBindings, ownerId: string, id: string): Promise<boolean> {
  const deleted = await chatDb(env).update(chat.userSummary).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(chat.userSummary.ownerId, ownerId), eq(chat.userSummary.id, id), isNull(chat.userSummary.deletedAt))).returning({ id: chat.userSummary.id });
  return deleted.length === 1;
}

export class SummaryEvidenceError extends Error {}

// Saves a summary the model wrote in a run. Every piece of evidence must have been read in this
// run (`receipts`) and still be at that version; coverage comes from the evidence's sources.
// `idempotencyKey` is the tool call's id, so a replayed call finds the summary it saved.
export async function saveSummary(
  env: ChatBindings,
  input: { ownerId: string; recordsUserId: string; runId: string; idempotencyKey: string; receipts: Receipt[]; title: string; text: string; coverageState: "complete" | "partial" | "unknown"; evidence: { kind: "record" | "note"; targetId: string }[] },
): Promise<SummaryView> {
  const db = chatDb(env);
  const [existing] = await db.select().from(chat.userSummary).where(and(eq(chat.userSummary.ownerId, input.ownerId), eq(chat.userSummary.idempotencyKey, input.idempotencyKey)));
  if (existing) return (await withFreshness(env, input.recordsUserId, [existing]))[0];
  if (new Set(input.evidence.map((e) => `${e.kind}:${e.targetId}`)).size !== input.evidence.length) throw new SummaryEvidenceError("duplicate_evidence");
  const states = await env.RECORDS.evidence(input.recordsUserId, input.evidence);
  for (const state of states) {
    if (!state.version) throw new SummaryEvidenceError("evidence_not_found");
    if (!input.receipts.some((r) => r.kind === state.kind && r.targetId === state.targetId && r.version === state.version)) throw new SummaryEvidenceError("evidence_not_read_in_this_run");
  }
  const sources = [...new Map(states.map((s) => [s.sourceId!, s])).values()];
  const asOf = sources.every((s) => s.sourceLastSyncedAt) ? sources.reduce((oldest, s) => (s.sourceLastSyncedAt! < oldest ? s.sourceLastSyncedAt! : oldest), sources[0].sourceLastSyncedAt!) : null;
  const now = new Date();
  const id = crypto.randomUUID();
  const evidence = input.evidence.map((e, position) => ({ id: crypto.randomUUID(), ownerId: input.ownerId, summaryId: id, kind: e.kind, targetId: e.targetId, version: states[position].version!, position }));
  const content = summaryContentSchema.parse({
    version: 1,
    text: input.text.trim(),
    evidence: evidence.map((e) => ({ id: e.id, kind: e.kind })),
    coverage: { state: sources.some((s) => s.sourceLastSyncStatus === "partial" || s.sourceLastSyncStatus === "failed") ? "partial" : input.coverageState, asOf: asOf ? new Date(asOf).toISOString() : null, sourceIds: sources.map((s) => s.sourceId!) },
    provenance: { runId: input.runId, generatedAt: now.toISOString() },
  });
  await db.batch([
    db.insert(chat.userSummary).values({ id, ownerId: input.ownerId, originatingRunId: input.runId, idempotencyKey: input.idempotencyKey, title: input.title.trim(), content, createdAt: now, updatedAt: now }),
    db.insert(chat.summaryEvidence).values(evidence),
  ]);
  return { id, title: input.title.trim(), content, freshness: "fresh", createdAt: now, updatedAt: now };
}

