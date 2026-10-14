import "server-only";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { extractionJob, extractionReference, extractionRun, session, wildcardFile } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import type { Db } from "@/lib/db/types";
import { hmacFor, sealField, unsealField, userKeysFor } from "@/lib/crypto/user-keys";
import { createSchema, METHODS, referenceSchema, resultSchema } from "./contracts";

const location = (id: string, field: string) => ({ table: "extraction_run", rowId: id, field });
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function grant(id: string, claimId: string, key: string) { return `whdoc1.${createHmac("sha256", key).update(`${id}:${claimId}`).digest("base64url")}`; }
export function enabledMethods() { return METHODS.filter(method => (process.env.EXTRACTION_METHODS ?? "native,tesseract").split(",").includes(method)); }
export function configured() { return process.env.EXTRACTION_ENABLED === "1" && enabledMethods().length > 0 && /^[a-f0-9]{64}$/.test(process.env.EXTRACTION_COORDINATOR_TOKEN_HASH ?? "") && (process.env.EXTRACTION_GRANT_KEY?.length ?? 0) >= 32; }

export async function enqueue(db: Db, kek: Buffer, userId: string, sessionId: string, raw: unknown) {
  const input = createSchema.parse(raw);
  if (input.methods.some(method => !enabledMethods().includes(method))) throw new Error("method_unavailable");
  return asUser(db, userId, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`extraction:${userId}`}))`);
    const [initiator] = await tx.select({ id: session.id }).from(session).where(and(eq(session.id, sessionId), eq(session.userId, userId), gt(session.expiresAt, new Date()))).for("share");
    if (!initiator) throw new Error("inactive_session");
    await tx.update(extractionJob).set({ status: "expired", grantHash: null }).where(and(eq(extractionJob.userId, userId), eq(extractionJob.status, "running"), sql`${extractionJob.deadlineAt} <= now()`));
    const active = await tx.select({ id: extractionJob.id }).from(extractionJob).where(and(eq(extractionJob.userId, userId), inArray(extractionJob.status, ["queued", "running"])));
    const files = [...new Set(input.fileIds)], methods = [...new Set(input.methods)];
    if (active.length + files.length * methods.length > 80) throw new Error("queue_full");
    const found = await tx.select({ id: wildcardFile.id }).from(wildcardFile).where(and(eq(wildcardFile.userId, userId), inArray(wildcardFile.id, files), eq(wildcardFile.status, "ready")));
    if (found.length !== files.length) throw new Error("file_unavailable");
    const keys = await userKeysFor(tx, kek, userId, new Date());
    const ids = [];
    for (const fileId of files) for (const method of methods) {
      const id = randomUUID();
      await tx.insert(extractionRun).values({ id, userId, fileId, method, sealedConfig: sealField(keys, JSON.stringify({ encounterDate: input.encounterDate ?? null }), location(id, "config")) });
      await tx.insert(extractionJob).values({ id, userId, sessionId });
      ids.push(id);
    }
    return ids;
  });
}

export async function listRuns(db: Db, kek: Buffer, userId: string, fileId?: string, resultId?: string) {
  return asUser(db, userId, async tx => {
    const rows = await tx.select({ run: extractionRun, job: extractionJob }).from(extractionRun).innerJoin(extractionJob, eq(extractionRun.id, extractionJob.id))
      .where(and(eq(extractionRun.userId, userId), fileId ? eq(extractionRun.fileId, fileId) : undefined)).orderBy(desc(extractionRun.createdAt)).limit(100);
    if (!rows.length) return [];
    const keys = await userKeysFor(tx, kek, userId, new Date());
    return rows.map(({ run, job }) => ({ id: run.id, fileId: run.fileId, method: run.method, status: job.status === "running" && job.deadlineAt && job.deadlineAt < new Date() ? "expired" : job.status,
      errorCode: job.errorCode, createdAt: run.createdAt.toISOString(), result: run.sealedResult && run.id === resultId ? resultSchema.parse(JSON.parse(unsealField(keys, run.sealedResult, location(run.id, "result")))) : null }));
  });
}

export async function saveReference(db: Db, kek: Buffer, userId: string, fileId: string, raw: unknown) {
  const labels = referenceSchema.parse(raw), id = randomUUID();
  return asUser(db, userId, async tx => {
    const [file] = await tx.select({ id: wildcardFile.id }).from(wildcardFile).where(and(eq(wildcardFile.id, fileId), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready")));
    if (!file) throw new Error("file_unavailable");
    const keys = await userKeysFor(tx, kek, userId, new Date());
    await tx.insert(extractionReference).values({ id, userId, fileId, sealedLabels: sealField(keys, JSON.stringify(labels), { table: "extraction_reference", rowId: id, field: "labels" }) });
    return id;
  });
}
export async function references(db: Db, kek: Buffer, userId: string, fileId: string, referenceId?: string) {
  return asUser(db, userId, async tx => {
    const rows = await tx.select({ id: extractionReference.id, createdAt: extractionReference.createdAt }).from(extractionReference).where(and(eq(extractionReference.userId, userId), eq(extractionReference.fileId, fileId))).orderBy(desc(extractionReference.createdAt)).limit(30);
    if (!rows.length) return [];
    const [selected] = referenceId ? await tx.select().from(extractionReference).where(and(eq(extractionReference.id, referenceId), eq(extractionReference.userId, userId), eq(extractionReference.fileId, fileId))) : [];
    const keys = selected ? await userKeysFor(tx, kek, userId, new Date()) : null;
    const labels = selected && keys ? referenceSchema.parse(JSON.parse(unsealField(keys, selected.sealedLabels, { table: "extraction_reference", rowId: selected.id, field: "labels" }))) : null;
    return rows.map(r => ({ id: r.id, createdAt: r.createdAt.toISOString(), labels: r.id === referenceId ? labels : null }));
  });
}
export async function cancel(db: Db, userId: string, id: string) {
  return asUser(db, userId, async tx => (await tx.update(extractionJob).set({ status: "cancelled", grantHash: null }).where(and(eq(extractionJob.id, id), eq(extractionJob.userId, userId), inArray(extractionJob.status, ["queued", "running"]))).returning({ id: extractionJob.id })).length > 0);
}

// This context reveals only queue metadata. It is never used for documents, keys, labels, or results.
async function queue<T>(db: Db, work: (tx: Db) => Promise<T>) {
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('app.extraction_dispatch', '1', true)`);
    return work(tx as unknown as Db);
  });
}
export async function claim(db: Db, requestId: string, key: string) {
  return queue(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('extraction-claim'))`);
    await tx.update(extractionJob).set({ status: "cancelled", grantHash: null }).where(and(inArray(extractionJob.status, ["queued", "running"]), sql`not exists (select 1 from public.session s where s.id = ${extractionJob.sessionId} and s.user_id = ${extractionJob.userId} and s.expires_at > now())`));
    const [previous] = await tx.select().from(extractionJob).where(eq(extractionJob.claimId, requestId));
    if (previous) return previous.status === "running" && previous.deadlineAt! > new Date() ? { id: previous.id, capability: grant(previous.id, requestId, key) } : null;
    // Recover monitoring after a coordinator restart without launching another job.
    const [active] = await tx.select().from(extractionJob).where(and(eq(extractionJob.status, "running"), gt(extractionJob.deadlineAt, new Date()))).orderBy(asc(extractionJob.createdAt)).limit(1);
    if (active?.claimId) return { id: active.id, capability: grant(active.id, active.claimId, key), resumed: true };
    const [next] = await tx.select().from(extractionJob).where(eq(extractionJob.status, "queued")).orderBy(asc(extractionJob.createdAt)).limit(1).for("update", { skipLocked: true });
    if (!next) return null;
    const capability = grant(next.id, requestId, key);
    await tx.update(extractionJob).set({ status: "running", claimId: requestId, grantHash: hash(capability), deadlineAt: new Date(Date.now() + 30 * 60_000) }).where(eq(extractionJob.id, next.id));
    return { id: next.id, capability };
  });
}
export async function authorized(db: Db, capability: string, allowCompleted = false) {
  if (!/^whdoc1\.[\w-]{43}$/.test(capability)) throw new Error("unauthorized");
  const row = await queue(db, async tx => (await tx.select().from(extractionJob).where(eq(extractionJob.grantHash, hash(capability))).limit(1))[0]);
  if (!row || !row.deadlineAt || row.deadlineAt <= new Date() || !(row.status === "running" || allowCompleted && row.status === "completed")) throw new Error("inactive");
  return asUser(db, row.userId, async tx => {
    const [active] = await tx.select({ id: session.id }).from(session).where(and(eq(session.id, row.sessionId), eq(session.userId, row.userId), gt(session.expiresAt, new Date())));
    const [run] = await tx.select().from(extractionRun).innerJoin(wildcardFile, eq(extractionRun.fileId, wildcardFile.id)).where(and(eq(extractionRun.id, row.id), eq(extractionRun.userId, row.userId), eq(wildcardFile.status, "ready"), eq(wildcardFile.userId, row.userId)));
    if (!active || !run) throw new Error("inactive");
    return { job: row, run: run.extraction_run };
  });
}
export async function workerConfig(db: Db, kek: Buffer, capability: string) {
  const { job, run } = await authorized(db, capability);
  return asUser(db, job.userId, async tx => {
    const keys = await userKeysFor(tx, kek, job.userId, new Date());
    return { method: run.method, ...JSON.parse(unsealField(keys, run.sealedConfig, location(run.id, "config"))), deadlineAt: job.deadlineAt!.toISOString() };
  });
}
export async function finish(db: Db, kek: Buffer, capability: string, raw: unknown) {
  const result = resultSchema.parse(raw);
  const { job, run } = await authorized(db, capability, true);
  if (result.method !== run.method) throw new Error("wrong_method");
  return asUser(db, job.userId, async tx => {
    // Serialize completion with logout/session revocation and document deletion.
    const [activeSession] = await tx.select({ id: session.id }).from(session).where(and(eq(session.id, job.sessionId), eq(session.userId, job.userId), gt(session.expiresAt, new Date()))).for("share");
    const [activeFile] = await tx.select({ id: wildcardFile.id }).from(wildcardFile).where(and(eq(wildcardFile.id, run.fileId), eq(wildcardFile.userId, job.userId), eq(wildcardFile.status, "ready"))).for("share");
    if (!activeSession || !activeFile) throw new Error("inactive");
    const [current] = await tx.select().from(extractionJob).where(eq(extractionJob.id, job.id)).for("update");
    if (!current || !current.deadlineAt || current.deadlineAt <= new Date() || !["running", "completed"].includes(current.status)) throw new Error("inactive");
    const keys = await userKeysFor(tx, kek, job.userId, new Date());
    const encoded = JSON.stringify(result), digest = hmacFor(keys, encoded);
    const [stored] = await tx.select().from(extractionRun).where(eq(extractionRun.id, job.id));
    if (stored.resultDigest) { if (stored.resultDigest !== digest) throw new Error("conflicting_result"); return; }
    await tx.update(extractionRun).set({ sealedResult: sealField(keys, encoded, location(job.id, "result")), resultDigest: digest }).where(eq(extractionRun.id, job.id));
    await tx.update(extractionJob).set({ status: "completed" }).where(eq(extractionJob.id, job.id));
  });
}
export async function fail(db: Db, capability: string) {
  const { job } = await authorized(db, capability);
  await asUser(db, job.userId, tx => tx.update(extractionJob).set({ status: "failed", errorCode: "processing_failed", grantHash: null }).where(and(eq(extractionJob.id, job.id), eq(extractionJob.status, "running"))));
}
