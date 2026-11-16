import { createHash, createHmac } from "node:crypto";
import { and, asc, count, desc, eq, inArray, lte, gt, sql } from "drizzle-orm";
import { auditGroups, auditResult, type AuditRow } from "@/lib/extraction/audit";
import { createSchema, METHODS, referenceSchema, resultSchema } from "@/lib/extraction/contracts";
import { combinedCoverage, type CoverageRun } from "@/lib/extraction/coverage";
import { publicFailureCode } from "@/lib/extraction/failures";
import { hmacFor, sealField, unsealField, type UserKeys } from "../crypto/fields";
import type { Db } from "../db";
import { extractionJob, extractionReference, extractionRun, session, wildcardFile } from "../db/schema";
import type { Bindings, Secrets } from "../env";
import { withLock } from "../locks";
import { forUser, inJson, system, type UserScope } from "./scope";
import { userKeysFor } from "./user-keys";

// Document extraction (src/lib/extraction/store.ts in the Next app): the owner's queue in the web
// backend, VPS workers claiming one attempt at a time with short-lived grants. Behaviour is
// unchanged. On D1 (docs/superpowers/specs/2026-10-30-d1-transaction-audit.md):
// - enqueueing and backfill, which Postgres kept apart per person with an advisory lock, run under
//   the person's UserLock; claims, under one global lock, as before;
// - finishing an attempt is one batch guarded on the grant, the file and (unless durable) the
//   session still being valid;
// - "latest per file" queries (DISTINCT ON) are ordered reads picked in code.
// Workers never see keys, ciphertext of other files, or anything but their own attempt.

type Job = typeof extractionJob.$inferSelect;
type Run = typeof extractionRun.$inferSelect;

const location = (id: string, field: string) => ({ table: "extraction_run", rowId: id, field });
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const grant = (id: string, claimId: string, key: string) => `whdoc1.${createHmac("sha256", key).update(`${id}:${claimId}`).digest("base64url")}`;
const ACTIVE = ["waiting", "queued", "running"];

export function enabledMethods(config: Secrets) {
  return METHODS.filter((method) => config.EXTRACTION_METHODS.split(",").includes(method));
}
export function configured(config: Secrets) {
  return config.EXTRACTION_ENABLED === "1" && enabledMethods(config).length > 0 && Boolean(config.EXTRACTION_COORDINATOR_TOKEN_HASH) && (config.EXTRACTION_GRANT_KEY?.length ?? 0) >= 32;
}

// The person's jobs with their runs (two owner-scoped reads, joined here).
async function jobsWithRuns(scope: UserScope, jobs: Job[]): Promise<{ job: Job; run: Run }[]> {
  if (!jobs.length) return [];
  const runs = new Map((await scope.select(extractionRun, inJson(extractionRun.id, jobs.map((j) => j.id)))).map((r) => [r.id, r]));
  return jobs.flatMap((job) => (runs.has(job.id) ? [{ job, run: runs.get(job.id)! }] : []));
}

async function readyFileIds(scope: UserScope, ids?: string[]): Promise<Set<string>> {
  const rows = await scope.selectFields(wildcardFile, { id: wildcardFile.id }, and(eq(wildcardFile.status, "ready"), ids ? inJson(wildcardFile.id, ids) : undefined));
  return new Set(rows.map((r) => r.id));
}

export const BACKFILL_BATCH_SIZE = 20;

export async function backfill(env: Bindings, config: Secrets, scope: UserScope, kek: Buffer, sessionId: string, resumeCancelled = false) {
  if (!enabledMethods(config).includes("native") || !enabledMethods(config).includes("tesseract")) throw new Error("method_unavailable");
  return withLock(env, `extraction:${scope.userId}`, async () => {
    if (!(await scope.sessionActive(sessionId))) throw new Error("inactive_session");
    const ready = await readyFileIds(scope);
    // Only the signed-in owner can extend authorization; configuration is read in owner context.
    const jobs = await scope.select(extractionJob, inArray(extractionJob.status, resumeCancelled ? [...ACTIVE, "cancelled"] : ACTIVE));
    const existing = (await jobsWithRuns(scope, jobs)).filter(({ run }) => ready.has(run.fileId));
    const keys = await userKeysFor(scope, kek, new Date());
    const upgrades: string[] = [];
    const resumptions: string[] = [];
    for (const { job, run } of existing) {
      if (JSON.parse(unsealField(keys, run.sealedConfig, location(job.id, "config"))).pipeline !== "native-ocr/v1" || job.errorCode === "cancelled_by_owner") continue;
      if (job.status === "cancelled") resumptions.push(job.id);
      else if (!job.durable) upgrades.push(job.id);
    }
    // Only ready documents that have never had a run: a repeated click can't enrol twice.
    const withRuns = new Set((await scope.selectFields(extractionRun, { fileId: extractionRun.fileId })).map((r) => r.fileId));
    const files = [...ready].filter((id) => !withRuns.has(id));
    const runs = files.map((fileId) => {
      const id = crypto.randomUUID();
      return { id, userId: scope.userId, fileId, method: "native", sealedConfig: sealField(keys, JSON.stringify({ encounterDate: null, pipeline: "native-ocr/v1" }), location(id, "config")) };
    });
    const now = new Date();
    await scope.batch([
      ...(upgrades.length ? [scope.update(extractionJob, { durable: true }, inJson(extractionJob.id, upgrades))] : []),
      ...(resumptions.length
        ? [scope.update(extractionJob, { durable: true, status: "waiting", sessionId, grantHash: null, claimId: null, deadlineAt: null, errorCode: null, nextAttemptAt: now }, inJson(extractionJob.id, resumptions))]
        : []),
      ...scope.bulkInsert(extractionRun, runs.map((r) => ({ ...r, createdAt: now }))),
      ...scope.bulkInsert(extractionJob, runs.map((r) => ({ id: r.id, userId: scope.userId, sessionId, status: "waiting", durable: true, attempts: 0, nextAttemptAt: now, createdAt: now }))),
    ]);
    return { enrolled: files.length, upgraded: upgrades.length, resumed: resumptions.length, batchSize: BACKFILL_BATCH_SIZE };
  });
}

export async function enqueue(
  env: Bindings,
  config: Secrets,
  scope: UserScope,
  kek: Buffer,
  sessionId: string,
  raw: unknown,
  lineage?: { parentRunId: string; expectedEnvironment: string; pipeline?: string },
): Promise<string[]> {
  const input = createSchema.parse(raw);
  if (input.methods.some((method) => !enabledMethods(config).includes(method))) throw new Error("method_unavailable");
  return withLock(env, `extraction:${scope.userId}`, async () => {
    if (!(await scope.sessionActive(sessionId))) throw new Error("inactive_session");
    const [active] = await scope.selectFields(extractionJob, { n: count() }, inArray(extractionJob.status, ["queued", "running"]));
    const files = [...new Set(input.fileIds)];
    const methods = [...new Set(input.methods)];
    if (active.n + files.length * methods.length > 80) throw new Error("queue_full");
    if ((await readyFileIds(scope, files)).size !== files.length) throw new Error("file_unavailable");
    const keys = await userKeysFor(scope, kek, new Date());
    const now = new Date();
    const runs = files.flatMap((fileId) =>
      methods.map((method) => {
        const id = crypto.randomUUID();
        return { id, userId: scope.userId, fileId, method, sealedConfig: sealField(keys, JSON.stringify({ encounterDate: input.encounterDate ?? null, ...lineage }), location(id, "config")), createdAt: now };
      }),
    );
    const backfilled = lineage?.pipeline === "native-ocr/v1";
    await scope.batch([
      ...scope.bulkInsert(extractionRun, runs),
      ...scope.bulkInsert(extractionJob, runs.map((r) => ({ id: r.id, userId: scope.userId, sessionId, status: backfilled ? "waiting" : "queued", durable: backfilled, attempts: 0, nextAttemptAt: now, createdAt: now }))),
    ]);
    return runs.map((r) => r.id);
  });
}

export async function rerun(env: Bindings, config: Secrets, scope: UserScope, kek: Buffer, sessionId: string, id: string): Promise<string[]> {
  const [run] = await scope.select(extractionRun, eq(extractionRun.id, id));
  if (!run) throw new Error("run_unavailable");
  const keys = await userKeysFor(scope, kek, new Date());
  const settings = JSON.parse(unsealField(keys, run.sealedConfig, location(id, "config")));
  const result = run.sealedResult ? resultSchema.parse(JSON.parse(unsealField(keys, run.sealedResult, location(id, "result")))) : null;
  const selection = { fileIds: [run.fileId], methods: [run.method], ...(settings.encounterDate ? { encounterDate: settings.encounterDate } : {}) };
  return enqueue(env, config, scope, kek, sessionId, selection, {
    parentRunId: id,
    expectedEnvironment: result?.manifest.environment_fingerprint ?? "unknown",
    ...(settings.pipeline === "native-ocr/v1" ? { pipeline: settings.pipeline } : {}),
  });
}

function statusOf(job: Job, now = new Date()) {
  return job.status === "running" && job.deadlineAt && job.deadlineAt < now ? "recovering" : job.status;
}

export async function listRuns(scope: UserScope, kek: Buffer, fileId?: string, resultId?: string) {
  const runs = await scope.select(extractionRun, fileId ? eq(extractionRun.fileId, fileId) : undefined).orderBy(desc(extractionRun.createdAt)).limit(100);
  if (!runs.length) return [];
  const jobs = new Map((await scope.select(extractionJob, inJson(extractionJob.id, runs.map((r) => r.id)))).map((j) => [j.id, j]));
  const keys = await userKeysFor(scope, kek, new Date());
  return runs.flatMap((run) => {
    const job = jobs.get(run.id);
    if (!job) return [];
    return [
      {
        id: run.id,
        fileId: run.fileId,
        method: run.method,
        status: statusOf(job),
        attempts: job.attempts,
        nextAttemptAt: job.nextAttemptAt.toISOString(),
        errorCode: job.errorCode,
        createdAt: run.createdAt.toISOString(),
        result: run.sealedResult && run.id === resultId ? resultSchema.parse(JSON.parse(unsealField(keys, run.sealedResult, location(run.id, "result")))) : null,
      },
    ];
  });
}

// Completed runs of these files, newest first (the "latest per file and method" reads).
async function completedRuns(scope: UserScope, fileIds: string[]): Promise<Run[]> {
  if (!fileIds.length) return [];
  const runs = await scope.select(extractionRun, inJson(extractionRun.fileId, fileIds)).orderBy(desc(extractionRun.createdAt), desc(extractionRun.id));
  if (!runs.length) return [];
  const completed = new Set((await scope.selectFields(extractionJob, { id: extractionJob.id }, and(inJson(extractionJob.id, runs.map((r) => r.id)), eq(extractionJob.status, "completed")))).map((j) => j.id));
  return runs.filter((r) => completed.has(r.id));
}

// Only requested visible files, and one completed result per method. Responses contain derived
// coverage, never extracted text, PII spans or page rasters.
export async function fileCoverage(scope: UserScope, kek: Buffer, fileIds: string[], details = false) {
  if (!fileIds.length || fileIds.length > 50) throw new Error("coverage_file_limit");
  const files = [...(await readyFileIds(scope, fileIds))];
  if (!files.length) return { files: [] };
  const latest = new Map<string, Run>();
  for (const run of await completedRuns(scope, files)) if (!latest.has(`${run.fileId}|${run.method}`)) latest.set(`${run.fileId}|${run.method}`, run);
  const keys: UserKeys | null = latest.size ? await userKeysFor(scope, kek, new Date()) : null;
  const output = [];
  for (const fileId of fileIds.filter((id) => files.includes(id))) {
    const runs: CoverageRun[] = [];
    for (const run of [...latest.values()].filter((r) => r.fileId === fileId)) {
      if (run.sealedResult && keys) runs.push({ id: run.id, method: run.method, result: resultSchema.parse(JSON.parse(unsealField(keys, run.sealedResult, location(run.id, "result")))) });
    }
    const { pages, ...summary } = combinedCoverage(runs);
    output.push({ fileId, coverage: details ? { ...summary, pages } : summary });
  }
  return { files: output };
}

// Account-wide progress reads dispatch metadata only, never document or result ciphertext.
export async function processingProgress(scope: UserScope) {
  const ready = await readyFileIds(scope);
  const runs = (await scope.selectFields(extractionRun, { id: extractionRun.id, fileId: extractionRun.fileId, method: extractionRun.method, createdAt: extractionRun.createdAt })).filter((r) => ready.has(r.fileId));
  const jobs = runs.length ? new Map((await scope.select(extractionJob, inJson(extractionJob.id, runs.map((r) => r.id)))).map((j) => [j.id, j])) : new Map<string, Job>();
  // Per file: an active run first, then the newest (Postgres used DISTINCT ON with this order).
  const rank = (r: (typeof runs)[number]) => [ACTIVE.includes(jobs.get(r.id)!.status) ? 0 : 1, -r.createdAt.getTime(), r.id] as const;
  const byFile = new Map<string, (typeof runs)[number]>();
  for (const run of runs.filter((r) => jobs.has(r.id))) {
    const current = byFile.get(run.fileId);
    const [a, b] = [rank(run), current ? rank(current) : undefined];
    if (!b || a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] > b[2])))) byFile.set(run.fileId, run);
  }
  const files = [...byFile.values()]
    .sort((a, b) => (a.fileId < b.fileId ? -1 : 1))
    .map((run) => {
      const job = jobs.get(run.id)!;
      return { fileId: run.fileId, id: run.id, method: run.method, status: statusOf(job), durable: job.durable, attempts: job.attempts, nextAttemptAt: job.nextAttemptAt.toISOString(), errorCode: job.errorCode };
    });
  const counts: Record<string, number> = { not_started: ready.size - files.length, waiting: 0, queued: 0, running: 0, recovering: 0, completed: 0, failed: 0, cancelled: 0, expired: 0 };
  for (const file of files) counts[file.status] = (counts[file.status] ?? 0) + 1;
  return { documents: ready.size, counts, files, durablePending: files.filter((f) => f.durable && ["waiting", "queued", "running", "recovering"].includes(f.status)).length };
}

export async function extractionAudit(scope: UserScope, kek: Buffer) {
  const limit = 200;
  const runs = await scope.select(extractionRun).orderBy(desc(extractionRun.createdAt)).limit(limit + 1);
  const selected = runs.slice(0, limit);
  const statuses = selected.length ? new Map((await scope.selectFields(extractionJob, { id: extractionJob.id, status: extractionJob.status }, inJson(extractionJob.id, selected.map((r) => r.id)))).map((j) => [j.id, j.status])) : new Map<string, string>();
  const rows: AuditRow[] = [];
  const types = new Map<string, string>();
  const labels = new Map<string, ReturnType<typeof referenceSchema.parse> | null>();
  const keys = selected.some((r) => statuses.get(r.id) === "completed") ? await userKeysFor(scope, kek, new Date()) : null;
  for (const item of selected) {
    if (statuses.get(item.id) !== "completed" || !keys || !item.sealedResult) continue;
    if (!types.has(item.fileId)) {
      const [file] = await scope.selectFields(wildcardFile, { metadata: wildcardFile.sealedMetadata }, eq(wildcardFile.id, item.fileId));
      if (!file) continue;
      types.set(item.fileId, JSON.parse(unsealField(keys, file.metadata, { table: "wildcard_file", rowId: item.fileId, field: "metadata" })).type);
      const [reference] = await scope.select(extractionReference, eq(extractionReference.fileId, item.fileId)).orderBy(desc(extractionReference.createdAt)).limit(1);
      labels.set(item.fileId, reference ? referenceSchema.parse(JSON.parse(unsealField(keys, reference.sealedLabels, { table: "extraction_reference", rowId: reference.id, field: "labels" }))) : null);
    }
    const result = resultSchema.parse(JSON.parse(unsealField(keys, item.sealedResult, location(item.id, "result"))));
    rows.push({ ...auditResult(result, types.get(item.fileId)!, labels.get(item.fileId)), runId: item.id, fileId: item.fileId, createdAt: item.createdAt.toISOString() });
  }
  return {
    generatedAt: new Date().toISOString(),
    limit,
    truncated: runs.length > limit,
    cohort: "Latest runs for the signed-in account; selected uploads, not a representative population sample",
    runStatuses: Object.fromEntries([...new Set(selected.map((r) => statuses.get(r.id)))].map((s) => [s, selected.filter((r) => statuses.get(r.id) === s).length])),
    rows,
    groups: auditGroups(rows),
  };
}

export async function saveReference(scope: UserScope, kek: Buffer, fileId: string, raw: unknown): Promise<string> {
  const labels = referenceSchema.parse(raw);
  const id = crypto.randomUUID();
  if (!(await readyFileIds(scope, [fileId])).size) throw new Error("file_unavailable");
  const keys = await userKeysFor(scope, kek, new Date());
  await scope.insert(extractionReference, { id, userId: scope.userId, fileId, sealedLabels: sealField(keys, JSON.stringify(labels), { table: "extraction_reference", rowId: id, field: "labels" }), createdAt: new Date() });
  return id;
}

export async function references(scope: UserScope, kek: Buffer, fileId: string, referenceId?: string) {
  const rows = await scope.selectFields(extractionReference, { id: extractionReference.id, createdAt: extractionReference.createdAt }, eq(extractionReference.fileId, fileId)).orderBy(desc(extractionReference.createdAt)).limit(30);
  if (!rows.length) return [];
  const [selected] = referenceId ? await scope.select(extractionReference, and(eq(extractionReference.id, referenceId), eq(extractionReference.fileId, fileId))) : [];
  const keys = selected ? await userKeysFor(scope, kek, new Date()) : null;
  const labels = selected && keys ? referenceSchema.parse(JSON.parse(unsealField(keys, selected.sealedLabels, { table: "extraction_reference", rowId: selected.id, field: "labels" }))) : null;
  return rows.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), labels: r.id === referenceId ? labels : null }));
}

export async function cancel(scope: UserScope, id: string): Promise<boolean> {
  const cancelled = await scope
    .update(extractionJob, { status: "cancelled", grantHash: null, errorCode: "cancelled_by_owner" }, and(eq(extractionJob.id, id), inArray(extractionJob.status, ACTIVE)))
    .returning({ id: extractionJob.id });
  return cancelled.length > 0;
}

// The coordinator's claim: queue metadata only (the system handle), one claim at a time
// (Postgres used a global advisory lock).
export async function claim(env: Bindings, db: Db, requestId: string, key: string, admitBackfill = false) {
  return withLock(env, "extraction-claim", async () => {
    const queue = system(db);
    const now = new Date();
    // Non-durable work ends with its session.
    await queue
      .update(extractionJob)
      .set({ status: "cancelled", grantHash: null })
      .where(and(eq(extractionJob.durable, false), inArray(extractionJob.status, ACTIVE), sql`not exists (select 1 from ${session} s where s.id = ${extractionJob.sessionId} and s.user_id = ${extractionJob.userId} and s.expires_at > ${now.getTime()})`));
    // The queue survives the VPS. Revoke expired attempt grants before issuing new ones.
    await queue
      .update(extractionJob)
      .set({ status: "queued", grantHash: null, claimId: null, deadlineAt: null, errorCode: "worker_interrupted", nextAttemptAt: new Date(now.getTime() + 30_000) })
      .where(and(eq(extractionJob.status, "running"), lte(extractionJob.deadlineAt, now)));
    const [previous] = await queue.select().from(extractionJob).where(eq(extractionJob.claimId, requestId));
    if (previous) return previous.status === "running" && previous.deadlineAt! > now ? { id: previous.id, capability: grant(previous.id, requestId, key), attempt: previous.attempts } : null;
    // Recover monitoring after a coordinator restart without launching another job.
    const [active] = await queue.select().from(extractionJob).where(and(eq(extractionJob.status, "running"), gt(extractionJob.deadlineAt, now))).orderBy(asc(extractionJob.createdAt)).limit(1);
    if (active?.claimId) return { id: active.id, capability: grant(active.id, active.claimId, key), resumed: true, attempt: active.attempts };
    const [{ total }] = await queue.select({ total: count() }).from(extractionJob).where(inArray(extractionJob.status, ["queued", "running"]));
    if (admitBackfill && total < BACKFILL_BATCH_SIZE) {
      const waiting = await queue.select({ id: extractionJob.id }).from(extractionJob).where(eq(extractionJob.status, "waiting")).orderBy(asc(extractionJob.createdAt), asc(extractionJob.id)).limit(BACKFILL_BATCH_SIZE - total);
      if (waiting.length) await queue.update(extractionJob).set({ status: "queued" }).where(inJson(extractionJob.id, waiting.map((r) => r.id)));
    }
    const [next] = await queue.select().from(extractionJob).where(and(eq(extractionJob.status, "queued"), lte(extractionJob.nextAttemptAt, now))).orderBy(asc(extractionJob.nextAttemptAt), asc(extractionJob.createdAt)).limit(1);
    if (!next) return null;
    const capability = grant(next.id, requestId, key);
    await queue
      .update(extractionJob)
      .set({ status: "running", claimId: requestId, grantHash: hash(capability), attempts: sql`${extractionJob.attempts} + 1`, deadlineAt: new Date(now.getTime() + 30 * 60_000) })
      .where(and(eq(extractionJob.id, next.id), eq(extractionJob.status, "queued")));
    return { id: next.id, capability, attempt: next.attempts + 1 };
  });
}

// The attempt a grant belongs to, if it's still current: the grant matches, the deadline hasn't
// passed, the file is ready, and the session is active unless the job is durable.
export async function authorized(db: Db, capability: string, allowCompleted = false): Promise<{ job: Job; run: Run; scope: UserScope }> {
  if (!/^whdoc1\.[\w-]{43}$/.test(capability)) throw new Error("unauthorized");
  const [job] = await system(db).select().from(extractionJob).where(eq(extractionJob.grantHash, hash(capability))).limit(1);
  if (!job || !job.deadlineAt || job.deadlineAt <= new Date() || !(job.status === "running" || (allowCompleted && job.status === "completed"))) throw new Error("inactive");
  const scope = forUser(db, job.userId);
  const [run] = await scope.select(extractionRun, eq(extractionRun.id, job.id));
  if (!run || !(await readyFileIds(scope, [run.fileId])).size || (!job.durable && !(await scope.sessionActive(job.sessionId)))) throw new Error("inactive");
  return { job, run, scope };
}

export async function workerConfig(db: Db, kek: Buffer, capability: string) {
  const { job, run, scope } = await authorized(db, capability);
  const keys = await userKeysFor(scope, kek, new Date());
  return { method: run.method, ...JSON.parse(unsealField(keys, run.sealedConfig, location(run.id, "config"))), attempt: job.attempts, deadlineAt: job.deadlineAt!.toISOString() };
}

// Stores a worker's result once. The result and the job's completion are one batch, guarded on
// the grant, the file and (unless durable) the session still being valid when it runs; a repeated
// identical result is accepted, a different one refused.
export async function finish(db: Db, kek: Buffer, capability: string, raw: unknown): Promise<void> {
  const result = resultSchema.parse(raw);
  const { job, run, scope } = await authorized(db, capability, true);
  if (result.method !== run.method) throw new Error("wrong_method");
  const keys = await userKeysFor(scope, kek, new Date());
  const encoded = JSON.stringify(result);
  const digest = hmacFor(keys, encoded);
  if (run.resultDigest) {
    if (run.resultDigest !== digest) throw new Error("conflicting_result");
    return;
  }
  const now = new Date();
  const stillValid = and(
    sql`exists (select 1 from ${extractionJob} j where j.id = ${job.id} and j.grant_hash = ${hash(capability)} and j.deadline_at > ${now.getTime()} and j.status in ('running', 'completed'))`,
    sql`exists (select 1 from ${wildcardFile} f where f.id = ${run.fileId} and f.user_id = ${scope.userId} and f.status = 'ready')`,
    job.durable ? undefined : scope.sessionActiveSql(job.sessionId, now),
  )!;
  const [stored] = await scope.batch([
    scope.update(extractionRun, { sealedResult: sealField(keys, encoded, location(job.id, "result")), resultDigest: digest }, and(eq(extractionRun.id, job.id), sql`${extractionRun.resultDigest} is null`, stillValid)).returning({ id: extractionRun.id }),
    scope.update(extractionJob, { status: "completed", errorCode: null }, and(eq(extractionJob.id, job.id), sql`exists (select 1 from ${extractionRun} r where r.id = ${job.id} and r.result_digest = ${digest})`)),
  ]);
  if (stored.length) return;
  // Nothing stored: either it was stored meanwhile (the same result is fine) or it's no longer valid.
  const [again] = await scope.selectFields(extractionRun, { resultDigest: extractionRun.resultDigest }, eq(extractionRun.id, job.id));
  if (again?.resultDigest === digest) return;
  throw new Error(again?.resultDigest ? "conflicting_result" : "inactive");
}

export async function fail(db: Db, capability: string, retryable = false, code?: unknown): Promise<void> {
  const { job, scope } = await authorized(db, capability);
  const delay = Math.min(30 * 2 ** Math.min(Math.max(job.attempts - 1, 0), 6), 1800);
  const reason = publicFailureCode(code);
  await scope.update(
    extractionJob,
    {
      status: retryable ? "queued" : "failed",
      errorCode: retryable ? (reason === "processing_failed" ? "service_unavailable_retrying" : `${reason}_retrying`) : reason,
      grantHash: null,
      claimId: null,
      deadlineAt: null,
      nextAttemptAt: new Date(Date.now() + delay * 1000),
    },
    and(eq(extractionJob.id, job.id), eq(extractionJob.status, "running"), eq(extractionJob.grantHash, hash(capability))),
  );
}

export class DocumentFhirError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

// A document's draft FHIR view (src/lib/extraction/fhir-store.ts in the Next app): the latest
// completed extraction, or the one asked for, checked against the file's verified fingerprint.
export async function loadDocumentFhir(scope: UserScope, kek: Buffer, fileId: string, origin: string, runId?: string) {
  const { fileMetadata } = await import("./documents");
  const { documentFhir } = await import("@/lib/extraction/fhir");
  const file = await fileMetadata(scope, kek, fileId);
  if (!file || file.status !== "ready") return null;
  const [source] = await scope.selectFields(wildcardFile, { contentFingerprint: wildcardFile.contentFingerprint }, and(eq(wildcardFile.id, fileId), eq(wildcardFile.status, "ready")));
  if (!source) return null;
  const runs = (await completedRuns(scope, [fileId])).slice(0, 100);
  const selected = runId ? runs.find((r) => r.id === runId) : runs[0];
  if ((runId && !selected) || (selected && !selected.sealedResult)) return null;
  const keys = selected ? await userKeysFor(scope, kek, new Date()) : null;
  const result = selected?.sealedResult && keys ? resultSchema.parse(JSON.parse(unsealField(keys, selected.sealedResult, location(selected.id, "result")))) : null;
  if (result && keys && source.contentFingerprint && source.contentFingerprint !== hmacFor(keys, `document-content:v1:${result.sourceSha256}`)) {
    throw new DocumentFhirError(409, "This extraction does not match the original file. Queue a new extraction before viewing its FHIR results.");
  }
  const run = selected && result ? { id: selected.id, createdAt: selected.createdAt.toISOString(), result } : undefined;
  const preview = documentFhir({ file, sourceUrl: new URL(`/api/wildcards/${file.id}`, origin).href, run });
  if (result && !source.contentFingerprint) preview.warnings.push("This older file has no verified content fingerprint. Source integrity needs review.");
  return {
    file,
    runs: runs.map((r) => ({ id: r.id, method: r.method, createdAt: r.createdAt.toISOString() })),
    selectedRunId: run?.id ?? null,
    method: result?.method ?? null,
    preview,
  };
}
