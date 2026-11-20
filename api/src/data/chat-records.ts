import { and, asc, count, eq, gt, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { CHAT_MAX_CANDIDATES, CHAT_MAX_NOTE_CHARS, chatToolSchemas } from "@/lib/chat/tools";
import { DEMO_MODE_COOKIE, demoSelected } from "@/lib/demo/identity";
import { DEMO_USER_ID } from "@/lib/demo/scenario";
import { describeResource } from "@/lib/fhir/describe";
import type { Observation } from "@/lib/fhir/types";
import { hmacFor, unsealField, type UserKeys } from "../crypto/fields";
import { fhirAttachment, fhirResource, healthSource, session, user } from "../db/schema";
import { database } from "../db";
import { secrets, type Bindings } from "../env";
import { recordsKey } from "../epic/credentials";
import { cookieValue, realSession } from "../session";
import { DEMO_GUEST_COOKIE } from "@/lib/demo/identity";
import { guestViewer } from "./demo";
import { openStoredRow } from "./records";
import { forUser, inJson, system, type UserScope } from "./scope";
import { userKeysFor } from "./user-keys";

// What the chat Worker may learn from the main database (docs/superpowers/specs/
// 2026-10-07-web-owned-chat-security-boundary.md, "Cloudflare topology"). Each function is one
// purpose: who a browser request is, whether its session still holds, and the answers of the
// record tools, computed here so the chat Worker never sees raw records, keys, session tokens,
// accounts, Epic connections or profiles. Every record read is scoped by `forUser`.

export type Receipt = { kind: "record" | "note"; targetId: string; version: string };
// How a run's access is fenced: a login's session (checked against the database each time), or,
// for a guest viewing the demo, the expiry of their viewer cookie.
export type Fence = { kind: "session"; sessionId: string; userId: string } | { kind: "until"; expiresAt: string };
export type ChatIdentity = { userId: string; demo: { viewer: "guest" | "member"; viewerId: string } | null; fence: Fence };

const current = [isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt)];
const keysFor = (env: Bindings, scope: UserScope) => userKeysFor(scope, recordsKey(secrets(env)), new Date());
const noteVersion = (keys: UserKeys, sealedText: string) => hmacFor(keys, `note-version:${sealedText}`);
const recordReceipt = (row: { id: string; contentHmac: string }): Receipt => ({ kind: "record", targetId: row.id, version: row.contentHmac });

// The identity a chat request acts as, from the browser's cookies (as `applicationSession`), with
// the fence a run started by it keeps. A signed-in demo viewer is fenced by their own login.
export async function identify(env: Bindings, cookie: string): Promise<ChatIdentity | null> {
  const headers = new Headers({ cookie });
  const login = await realSession(env, headers);
  if (login) {
    if (!login.user.emailVerified) return null;
    const fence: Fence = { kind: "session", sessionId: login.session.id, userId: login.user.id };
    const viewingDemo = cookie.includes(`${DEMO_MODE_COOKIE}=`) && demoSelected(headers, login.session.id);
    return viewingDemo ? { userId: DEMO_USER_ID, demo: { viewer: "member", viewerId: login.user.id }, fence } : { userId: login.user.id, demo: null, fence };
  }
  const guest = guestViewer(secrets(env).BETTER_AUTH_SECRET, cookieValue(headers, DEMO_GUEST_COOKIE));
  return guest ? { userId: DEMO_USER_ID, demo: { viewer: "guest", viewerId: guest.id }, fence: { kind: "until", expiresAt: guest.expiresAt.toISOString() } } : null;
}

// Whether a fence still holds, and until when (`chat_lock_session_v2` on Postgres): the session
// exists for that person, hasn't expired, and the person's email is verified.
export async function sessionFence(env: Bindings, fence: Fence, now = new Date()): Promise<string | null> {
  if (fence.kind === "until") return new Date(fence.expiresAt) > now ? fence.expiresAt : null;
  const [found] = await system(database(env.DB)).select({ expiresAt: session.expiresAt }).from(session).innerJoin(user, eq(user.id, session.userId))
    .where(and(eq(session.id, fence.sessionId), eq(session.userId, fence.userId), gt(session.expiresAt, now), eq(user.emailVerified, true)));
  return found ? found.expiresAt.toISOString() : null;
}

export async function dataCoverage(env: Bindings, userId: string) {
  const scope = forUser(database(env.DB), userId);
  const [sources, counts] = await Promise.all([
    scope.selectFields(healthSource, { id: healthSource.id, status: healthSource.status, lastSyncedAt: healthSource.lastSyncedAt, lastSyncStatus: healthSource.lastSyncStatus }),
    scope.selectFields(fhirResource, { category: fhirResource.category, total: count() }, and(...current, isNotNull(fhirResource.category))).groupBy(fhirResource.category),
  ]);
  return {
    output: { sources, categories: counts.filter((row) => row.category).map((row) => ({ category: row.category, count: row.total })), coverage: sources.some((s) => s.lastSyncStatus === "partial" || s.lastSyncStatus === "failed") ? "partial" : sources.length ? "unknown" : "none" },
    receipts: [] as Receipt[],
  };
}

export async function findRecords(env: Bindings, userId: string, raw: unknown) {
  const input = chatToolSchemas.find_records.parse(raw);
  const scope = forUser(database(env.DB), userId);
  const conditions = [...current, isNotNull(fhirResource.category)];
  if (input.categories?.length) conditions.push(inJson(fhirResource.category, input.categories));
  if (input.resourceTypes?.length) conditions.push(inJson(fhirResource.resourceType, input.resourceTypes));
  if (input.sourceIds?.length) conditions.push(inJson(fhirResource.sourceId, input.sourceIds));
  if (input.from) conditions.push(gte(fhirResource.effectiveAt, new Date(`${input.from}T00:00:00Z`)));
  if (input.to) conditions.push(lt(fhirResource.effectiveAt, new Date(`${input.to}T00:00:00Z`)));
  const rows = await scope.select(fhirResource, and(...conditions)).orderBy(asc(fhirResource.effectiveAt)).limit(CHAT_MAX_CANDIDATES);
  const keys = await keysFor(env, scope);
  const query = input.query?.toLocaleLowerCase();
  const matched = rows.flatMap((row) => {
    const opened = openStoredRow(keys, row);
    const haystack = `${opened.summary.title} ${opened.summary.detail ?? ""} ${opened.summary.status ?? ""}`.toLocaleLowerCase();
    if (query && !haystack.includes(query)) return [];
    return [{ row, view: { citation: { kind: "record" as const, id: row.id }, resourceType: row.resourceType, date: row.effectiveAt?.toISOString() ?? null, title: opened.summary.title, detail: opened.summary.detail, status: opened.summary.status } }];
  });
  const records = matched.slice(0, input.limit);
  return { output: { records: records.map((r) => r.view), truncated: rows.length === CHAT_MAX_CANDIDATES || matched.length > input.limit }, receipts: records.map((r) => recordReceipt(r.row)) };
}

export async function readRecords(env: Bindings, userId: string, raw: unknown) {
  const input = chatToolSchemas.read_records.parse(raw);
  const scope = forUser(database(env.DB), userId);
  const rows = await scope.select(fhirResource, and(inJson(fhirResource.id, input.recordIds), ...current));
  const keys = await keysFor(env, scope);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const output = input.recordIds.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    const opened = openStoredRow(keys, row);
    return [{ citation: { kind: "record" as const, id }, resourceType: row.resourceType, summary: opened.summary, details: input.includeDetails ? describeResource(opened.resource) : undefined }];
  });
  return { output, receipts: rows.map(recordReceipt) };
}

export async function readStoredNote(env: Bindings, userId: string, raw: unknown) {
  const input = chatToolSchemas.read_stored_note.parse(raw);
  const scope = forUser(database(env.DB), userId);
  const [row] = await scope.select(fhirAttachment, eq(fhirAttachment.id, input.attachmentId)).limit(1);
  if (!row) return { output: { available: false, reason: "not_found" }, receipts: [] as Receipt[] };
  if (!row.sealedText) return { output: { available: false, reason: "not_stored_as_text" }, receipts: [] as Receipt[] };
  const keys = await keysFor(env, scope);
  const text = unsealField(keys, row.sealedText, { table: "fhir_attachment", field: "text", rowId: row.id });
  return {
    output: { available: true, citation: { kind: "note" as const, id: row.id }, text: text.slice(0, CHAT_MAX_NOTE_CHARS), truncated: text.length > CHAT_MAX_NOTE_CHARS },
    receipts: [{ kind: "note", targetId: row.id, version: noteVersion(keys, row.sealedText) }] as Receipt[],
  };
}

export async function labTrend(env: Bindings, userId: string, raw: unknown) {
  const input = chatToolSchemas.calculate_lab_trend.parse(raw);
  const scope = forUser(database(env.DB), userId);
  const rows = await scope.select(fhirResource, and(inJson(fhirResource.id, input.recordIds), ...current));
  const keys = await keysFor(env, scope);
  const points = rows.map((row) => ({ row, resource: openStoredRow(keys, row).resource as Observation }));
  const refuse = (reason: string) => ({ output: { ok: false, reason }, receipts: [] as Receipt[] });
  if (points.length !== input.recordIds.length || points.some((p) => p.resource.resourceType !== "Observation" || p.resource.valueQuantity?.value === undefined)) return refuse("Records must be current quantitative observations");
  const label = (observation: Observation) => {
    const coded = observation.code?.coding?.find((c) => c.system && c.code);
    return coded ? `${coded.system}|${coded.code}` : observation.code?.text ?? "";
  };
  const first = points[0].resource;
  const expectedLabel = label(first);
  const unit = first.valueQuantity?.unit ?? "";
  if (!expectedLabel || points.some((p) => label(p.resource) !== expectedLabel || (p.resource.valueQuantity?.unit ?? "") !== unit || !p.row.effectiveAt)) return refuse("Records must be the same test with the same unit and dates");
  const ordered = points.sort((a, b) => a.row.effectiveAt!.getTime() - b.row.effectiveAt!.getTime())
    .map((p) => ({ citation: { kind: "record" as const, id: p.row.id }, at: p.row.effectiveAt!.toISOString(), value: p.resource.valueQuantity!.value!, unit }));
  return { output: { ok: true, test: first.code?.text ?? expectedLabel, unit, points: ordered, change: ordered[ordered.length - 1].value - ordered[0].value }, receipts: rows.map(recordReceipt) };
}

// The current state of summary evidence: its version now (null when gone, superseded or
// removed) and its source's sync coverage. Saving a summary checks these against the run's
// receipts; listing summaries uses them for freshness.
export type EvidenceState = { kind: "record" | "note"; targetId: string; version: string | null; sourceId: string | null; sourceLastSyncedAt: Date | null; sourceLastSyncStatus: string | null };

export async function evidence(env: Bindings, userId: string, targets: { kind: "record" | "note"; targetId: string }[]): Promise<EvidenceState[]> {
  if (targets.length > 200) throw new Error("too_many_targets");
  const scope = forUser(database(env.DB), userId);
  const noteIds = targets.filter((t) => t.kind === "note").map((t) => t.targetId);
  const notes = noteIds.length ? await scope.select(fhirAttachment, inJson(fhirAttachment.id, noteIds)) : [];
  const recordIds = [...targets.filter((t) => t.kind === "record").map((t) => t.targetId), ...notes.map((n) => n.resourceId)];
  const records = recordIds.length ? await scope.selectFields(fhirResource, { id: fhirResource.id, version: fhirResource.contentHmac, sourceId: fhirResource.sourceId }, and(inJson(fhirResource.id, recordIds), ...current)) : [];
  const sourceIds = [...new Set([...records.map((r) => r.sourceId), ...notes.map((n) => n.sourceId)])];
  const sources = sourceIds.length ? await scope.selectFields(healthSource, { id: healthSource.id, lastSyncedAt: healthSource.lastSyncedAt, lastSyncStatus: healthSource.lastSyncStatus }, inJson(healthSource.id, sourceIds)) : [];
  const keys = notes.length ? await keysFor(env, scope) : undefined;
  return targets.map((target) => {
    let version: string | null = null, sourceId: string | null = null;
    if (target.kind === "record") {
      const record = records.find((r) => r.id === target.targetId);
      if (record) [version, sourceId] = [record.version, record.sourceId];
    } else {
      const note = notes.find((n) => n.id === target.targetId);
      if (note) {
        sourceId = note.sourceId;
        if (note.sealedText && records.some((r) => r.id === note.resourceId)) version = noteVersion(keys!, note.sealedText);
      }
    }
    const source = sources.find((s) => s.id === sourceId);
    return { ...target, version, sourceId, sourceLastSyncedAt: source?.lastSyncedAt ?? null, sourceLastSyncStatus: source?.lastSyncStatus ?? null };
  });
}

// What the browser's "record sources" panel shows for a run's receipts: each record or note as
// it was read (a changed version is left out rather than substituted), without the raw FHIR,
// patient identifiers or attachment addresses.
export type RecordSourceView = {
  id: string; kind: "record" | "note"; title: string; detail: string | null; date: string | null; organization: string;
  reference: string; version: string | null; earlierVersion: boolean; sections: { label: string; values: string[] }[];
  noteExcerpt?: string; viaSummary?: boolean; truncated: boolean;
};

export async function recordSources(env: Bindings, userId: string, receipts: (Receipt & { noteExcerpt?: string; viaSummary?: boolean })[]): Promise<RecordSourceView[]> {
  if (receipts.length > 32) throw new Error("too_many_receipts");
  const scope = forUser(database(env.DB), userId);
  const noteIds = receipts.filter((r) => r.kind === "note").map((r) => r.targetId);
  const notes = noteIds.length ? await scope.select(fhirAttachment, inJson(fhirAttachment.id, noteIds)) : [];
  const recordIds = [...receipts.filter((r) => r.kind === "record").map((r) => r.targetId), ...notes.map((n) => n.resourceId)];
  const records = recordIds.length ? await scope.select(fhirResource, and(inJson(fhirResource.id, recordIds), isNull(fhirResource.removedAt))) : [];
  const sourceIds = [...new Set(records.map((r) => r.sourceId))];
  const organizations = sourceIds.length ? await scope.selectFields(healthSource, { id: healthSource.id, name: healthSource.organizationName }, inArray(healthSource.id, sourceIds)) : [];
  const keys = records.length ? await keysFor(env, scope) : undefined;
  const views: RecordSourceView[] = [];
  for (const receipt of receipts) {
    const note = receipt.kind === "note" ? notes.find((n) => n.id === receipt.targetId) : undefined;
    const record = records.find((r) => r.id === (receipt.kind === "record" ? receipt.targetId : note?.resourceId));
    if (!record || (receipt.kind === "record" ? record.contentHmac !== receipt.version : !note?.sealedText || noteVersion(keys!, note.sealedText) !== receipt.version)) continue;
    const opened = openStoredRow(keys!, record);
    const sections = describeResource(opened.resource);
    const bounded = sections.slice(0, 20).map((s) => ({ label: s.label.slice(0, 200), values: s.values.slice(0, 10).map((v) => v.slice(0, 500)) }));
    views.push({
      id: receipt.targetId, kind: receipt.kind, title: opened.summary.title.slice(0, 500), detail: opened.summary.detail?.slice(0, 1000) ?? null,
      date: record.effectiveAt?.toISOString() ?? opened.summary.date ?? null,
      organization: organizations.find((o) => o.id === record.sourceId)?.name.slice(0, 500) ?? "Saved health record",
      reference: `${record.resourceType}/${record.fhirId}`, version: record.sourceVersionId, earlierVersion: record.supersededAt !== null,
      ...(receipt.viaSummary ? { viaSummary: true } : {}), sections: bounded,
      ...(receipt.noteExcerpt ? { noteExcerpt: receipt.noteExcerpt.slice(0, 2000) } : {}),
      truncated: JSON.stringify(sections) !== JSON.stringify(bounded) || (receipt.noteExcerpt?.length ?? 0) > 2000,
    });
  }
  return views;
}
