import "server-only";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { extractionJob, extractionReference, extractionRun, session, wildcardFile } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import type { Db } from "@/lib/db/types";
import { hmacFor, sealField, unsealField, userKeysFor } from "@/lib/crypto/user-keys";
import { createSchema, METHODS, referenceSchema, resultSchema } from "./contracts";
import { auditGroups, auditResult, type AuditRow } from "./audit";
import { publicFailureCode } from "./failures";

const location = (id: string, field: string) => ({ table: "extraction_run", rowId: id, field });
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function grant(id: string, claimId: string, key: string) { return `whdoc1.${createHmac("sha256", key).update(`${id}:${claimId}`).digest("base64url")}`; }
export function enabledMethods() { return METHODS.filter(method => (process.env.EXTRACTION_METHODS ?? "native,tesseract").split(",").includes(method)); }
export function configured() { return process.env.EXTRACTION_ENABLED === "1" && enabledMethods().length > 0 && /^[a-f0-9]{64}$/.test(process.env.EXTRACTION_COORDINATOR_TOKEN_HASH ?? "") && (process.env.EXTRACTION_GRANT_KEY?.length ?? 0) >= 32; }

export const BACKFILL_BATCH_SIZE = 20;
export async function backfill(db: Db, kek: Buffer, userId: string, sessionId: string) {
  if (!enabledMethods().includes("native") || !enabledMethods().includes("tesseract")) throw new Error("method_unavailable");
  return asUser(db, userId, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`extraction:${userId}`}))`);
    const [initiator] = await tx.select({ id: session.id }).from(session).where(and(eq(session.id, sessionId), eq(session.userId, userId), gt(session.expiresAt, new Date()))).for("share");
    if (!initiator) throw new Error("inactive_session");
    // Snapshot only ready documents that have never had a run. A repeated click
    // cannot duplicate enrollment or silently rerun an existing document.
    const files = await tx.select({ id: wildcardFile.id }).from(wildcardFile).where(and(eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"),
      sql`not exists (select 1 from extraction_run r where r.file_id = ${wildcardFile.id} and r.user_id = ${userId})`)).for("share");
    const keys = files.length ? await userKeysFor(tx, kek, userId, new Date()) : null;
    for (let offset = 0; offset < files.length; offset += BACKFILL_BATCH_SIZE) {
      const runs = files.slice(offset, offset + BACKFILL_BATCH_SIZE).map(file => {
        const id = randomUUID();
        return { id, userId, fileId: file.id, method: "native", sealedConfig: sealField(keys!, JSON.stringify({ encounterDate: null, pipeline: "native-ocr/v1" }), location(id, "config")) };
      });
      await tx.insert(extractionRun).values(runs);
      await tx.insert(extractionJob).values(runs.map(r => ({ id: r.id, userId, sessionId, status: "waiting" })));
    }
    return { enrolled: files.length, batchSize: BACKFILL_BATCH_SIZE };
  });
}

export async function enqueue(db: Db, kek: Buffer, userId: string, sessionId: string, raw: unknown, lineage?: { parentRunId: string; expectedEnvironment: string; pipeline?: string }) {
  const input = createSchema.parse(raw);
  if (input.methods.some(method => !enabledMethods().includes(method))) throw new Error("method_unavailable");
  return asUser(db, userId, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`extraction:${userId}`}))`);
    const [initiator] = await tx.select({ id: session.id }).from(session).where(and(eq(session.id, sessionId), eq(session.userId, userId), gt(session.expiresAt, new Date()))).for("share");
    if (!initiator) throw new Error("inactive_session");
    const active = await tx.select({ id: extractionJob.id }).from(extractionJob).where(and(eq(extractionJob.userId, userId), inArray(extractionJob.status, ["queued", "running"])));
    const files = [...new Set(input.fileIds)], methods = [...new Set(input.methods)];
    if (active.length + files.length * methods.length > 80) throw new Error("queue_full");
    const found = await tx.select({ id: wildcardFile.id }).from(wildcardFile).where(and(eq(wildcardFile.userId, userId), inArray(wildcardFile.id, files), eq(wildcardFile.status, "ready")));
    if (found.length !== files.length) throw new Error("file_unavailable");
    const keys = await userKeysFor(tx, kek, userId, new Date());
    const ids = [];
    for (const fileId of files) for (const method of methods) {
      const id = randomUUID();
      await tx.insert(extractionRun).values({ id, userId, fileId, method, sealedConfig: sealField(keys, JSON.stringify({ encounterDate: input.encounterDate ?? null, ...lineage }), location(id, "config")) });
      await tx.insert(extractionJob).values({ id, userId, sessionId, ...(lineage?.pipeline === "native-ocr/v1" ? { status: "waiting" } : {}) });
      ids.push(id);
    }
    return ids;
  });
}

export async function rerun(db: Db, kek: Buffer, userId: string, sessionId: string, id: string) {
  const input = await asUser(db,userId,async tx => {
    const [run] = await tx.select().from(extractionRun).where(and(eq(extractionRun.id,id),eq(extractionRun.userId,userId)));
    if(!run) throw new Error("run_unavailable");
    const keys=await userKeysFor(tx,kek,userId,new Date());
    const config=JSON.parse(unsealField(keys,run.sealedConfig,location(id,"config")));
    const result=run.sealedResult ? resultSchema.parse(JSON.parse(unsealField(keys,run.sealedResult,location(id,"result")))) : null;
    return { fileIds:[run.fileId],methods:[run.method],...(config.encounterDate ? {encounterDate:config.encounterDate} : {}), expectedEnvironment:result?.manifest.environment_fingerprint ?? "unknown", pipeline:config.pipeline };
  });
  const {expectedEnvironment,pipeline,...selection}=input;
  return enqueue(db,kek,userId,sessionId,selection,{parentRunId:id,expectedEnvironment,...(pipeline === "native-ocr/v1" ? {pipeline} : {})});
}

export async function listRuns(db: Db, kek: Buffer, userId: string, fileId?: string, resultId?: string) {
  return asUser(db, userId, async tx => {
    const rows = await tx.select({ run: extractionRun, job: extractionJob }).from(extractionRun).innerJoin(extractionJob, eq(extractionRun.id, extractionJob.id))
      .where(and(eq(extractionRun.userId, userId), fileId ? eq(extractionRun.fileId, fileId) : undefined)).orderBy(desc(extractionRun.createdAt)).limit(100);
    if (!rows.length) return [];
    const keys = await userKeysFor(tx, kek, userId, new Date());
    return rows.map(({ run, job }) => ({ id: run.id, fileId: run.fileId, method: run.method, status: job.status === "running" && job.deadlineAt && job.deadlineAt < new Date() ? "recovering" : job.status,
      attempts: job.attempts, nextAttemptAt: job.nextAttemptAt.toISOString(),
      errorCode: job.errorCode, createdAt: run.createdAt.toISOString(), result: run.sealedResult && run.id === resultId ? resultSchema.parse(JSON.parse(unsealField(keys, run.sealedResult, location(run.id, "result")))) : null }));
  });
}

// Account-wide progress reads dispatch metadata only, never document/result ciphertext.
export async function processingProgress(db: Db, userId: string) {
  return asUser(db, userId, async tx => {
    const [total] = await tx.select({ count: sql<number>`count(*)::int` }).from(wildcardFile).where(and(eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready")));
    const rows = await tx.selectDistinctOn([extractionRun.fileId], { fileId: extractionRun.fileId, id: extractionRun.id, method: extractionRun.method,
      status: extractionJob.status, attempts: extractionJob.attempts, nextAttemptAt: extractionJob.nextAttemptAt, deadlineAt: extractionJob.deadlineAt, errorCode: extractionJob.errorCode })
      .from(extractionRun).innerJoin(extractionJob, eq(extractionJob.id, extractionRun.id)).innerJoin(wildcardFile, eq(wildcardFile.id, extractionRun.fileId))
      .where(and(eq(extractionRun.userId, userId), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready")))
      .orderBy(extractionRun.fileId, sql`case when ${extractionJob.status} in ('waiting', 'queued', 'running') then 0 else 1 end`, desc(extractionRun.createdAt), desc(extractionRun.id));
    const files = rows.map(({ deadlineAt, ...r }) => ({ ...r, nextAttemptAt: r.nextAttemptAt.toISOString(), status: r.status === "running" && deadlineAt && deadlineAt < new Date() ? "recovering" : r.status }));
    const counts: Record<string, number> = { not_started: total.count - files.length, waiting: 0, queued: 0, running: 0, recovering: 0, completed: 0, failed: 0, cancelled: 0, expired: 0 };
    for (const file of files) counts[file.status] = (counts[file.status] ?? 0) + 1;
    return { documents: total.count, counts, files };
  });
}

export async function extractionAudit(db:Db,kek:Buffer,userId:string) {
  return asUser(db,userId,async tx=>{
    const limit=200;
    const metadata=await tx.select({id:extractionRun.id,fileId:extractionRun.fileId,method:extractionRun.method,createdAt:extractionRun.createdAt,status:extractionJob.status})
      .from(extractionRun).innerJoin(extractionJob,eq(extractionRun.id,extractionJob.id)).where(eq(extractionRun.userId,userId)).orderBy(desc(extractionRun.createdAt)).limit(limit+1);
    const selected=metadata.slice(0,limit),rows:AuditRow[]=[],types=new Map<string,string>(),labels=new Map<string,ReturnType<typeof referenceSchema.parse>|null>();
    const keys=selected.some(r=>r.status==="completed") ? await userKeysFor(tx,kek,userId,new Date()):null;
    for(const item of selected) {
      if(item.status!=="completed" || !keys)continue;
      const [stored]=await tx.select({result:extractionRun.sealedResult}).from(extractionRun).where(eq(extractionRun.id,item.id));
      if(!stored?.result)continue;
      if(!types.has(item.fileId)) {
        const [file]=await tx.select({metadata:wildcardFile.sealedMetadata}).from(wildcardFile).where(eq(wildcardFile.id,item.fileId));
        if(!file)continue;
        types.set(item.fileId,JSON.parse(unsealField(keys,file.metadata,{table:"wildcard_file",rowId:item.fileId,field:"metadata"})).type);
        const [reference]=await tx.select().from(extractionReference).where(eq(extractionReference.fileId,item.fileId)).orderBy(desc(extractionReference.createdAt)).limit(1);
        labels.set(item.fileId,reference ? referenceSchema.parse(JSON.parse(unsealField(keys,reference.sealedLabels,{table:"extraction_reference",rowId:reference.id,field:"labels"}))):null);
      }
      const result=resultSchema.parse(JSON.parse(unsealField(keys,stored.result,location(item.id,"result"))));
      rows.push({...auditResult(result,types.get(item.fileId)!,labels.get(item.fileId)),runId:item.id,fileId:item.fileId,createdAt:item.createdAt.toISOString()});
    }
    return {generatedAt:new Date().toISOString(),limit,truncated:metadata.length>limit,cohort:"Latest runs for the signed-in account; selected uploads, not a representative population sample",runStatuses:Object.fromEntries([...new Set(selected.map(r=>r.status))].map(s=>[s,selected.filter(r=>r.status===s).length])),rows,groups:auditGroups(rows)};
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
  return asUser(db, userId, async tx => (await tx.update(extractionJob).set({ status: "cancelled", grantHash: null }).where(and(eq(extractionJob.id, id), eq(extractionJob.userId, userId), inArray(extractionJob.status, ["waiting", "queued", "running"]))).returning({ id: extractionJob.id })).length > 0);
}

// This context reveals only queue metadata. It is never used for documents, keys, labels, or results.
async function queue<T>(db: Db, work: (tx: Db) => Promise<T>) {
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('app.extraction_dispatch', '1', true)`);
    return work(tx as unknown as Db);
  });
}
export async function claim(db: Db, requestId: string, key: string, admitBackfill = false) {
  return queue(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('extraction-claim'))`);
    await tx.update(extractionJob).set({ status: "cancelled", grantHash: null }).where(and(inArray(extractionJob.status, ["waiting", "queued", "running"]), sql`not exists (select 1 from public.session s where s.id = ${extractionJob.sessionId} and s.user_id = ${extractionJob.userId} and s.expires_at > now())`));
    // The queue survives the VPS. Revoke expired attempt grants before issuing new ones.
    await tx.update(extractionJob).set({ status: "queued", grantHash: null, claimId: null, deadlineAt: null,
      errorCode: "worker_interrupted", nextAttemptAt: new Date(Date.now() + 30_000) })
      .where(and(eq(extractionJob.status, "running"), sql`${extractionJob.deadlineAt} <= now()`));
    const [previous] = await tx.select().from(extractionJob).where(eq(extractionJob.claimId, requestId));
    if (previous) return previous.status === "running" && previous.deadlineAt! > new Date() ? { id: previous.id, capability: grant(previous.id, requestId, key), attempt: previous.attempts } : null;
    // Recover monitoring after a coordinator restart without launching another job.
    const [active] = await tx.select().from(extractionJob).where(and(eq(extractionJob.status, "running"), gt(extractionJob.deadlineAt, new Date()))).orderBy(asc(extractionJob.createdAt)).limit(1);
    if (active?.claimId) return { id: active.id, capability: grant(active.id, active.claimId, key), resumed: true, attempt: active.attempts };
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(extractionJob).where(inArray(extractionJob.status, ["queued", "running"]));
    if (admitBackfill && count.total < BACKFILL_BATCH_SIZE) {
      const waiting = await tx.select({ id: extractionJob.id }).from(extractionJob).where(eq(extractionJob.status, "waiting")).orderBy(asc(extractionJob.createdAt), asc(extractionJob.id)).limit(BACKFILL_BATCH_SIZE - count.total).for("update", { skipLocked: true });
      if (waiting.length) await tx.update(extractionJob).set({ status: "queued" }).where(inArray(extractionJob.id, waiting.map(r => r.id)));
    }
    const [next] = await tx.select().from(extractionJob).where(and(eq(extractionJob.status, "queued"), sql`${extractionJob.nextAttemptAt} <= now()`)).orderBy(asc(extractionJob.nextAttemptAt), asc(extractionJob.createdAt)).limit(1).for("update", { skipLocked: true });
    if (!next) return null;
    const capability = grant(next.id, requestId, key);
    await tx.update(extractionJob).set({ status: "running", claimId: requestId, grantHash: hash(capability), attempts: sql`${extractionJob.attempts} + 1`, deadlineAt: new Date(Date.now() + 30 * 60_000) }).where(eq(extractionJob.id, next.id));
    return { id: next.id, capability, attempt: next.attempts + 1 };
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
    return { method: run.method, ...JSON.parse(unsealField(keys, run.sealedConfig, location(run.id, "config"))), attempt: job.attempts, deadlineAt: job.deadlineAt!.toISOString() };
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
    if (!current || current.grantHash !== hash(capability) || !current.deadlineAt || current.deadlineAt <= new Date() || !["running", "completed"].includes(current.status)) throw new Error("inactive");
    const keys = await userKeysFor(tx, kek, job.userId, new Date());
    const encoded = JSON.stringify(result), digest = hmacFor(keys, encoded);
    const [stored] = await tx.select().from(extractionRun).where(eq(extractionRun.id, job.id));
    if (stored.resultDigest) { if (stored.resultDigest !== digest) throw new Error("conflicting_result"); return; }
    await tx.update(extractionRun).set({ sealedResult: sealField(keys, encoded, location(job.id, "result")), resultDigest: digest }).where(eq(extractionRun.id, job.id));
    await tx.update(extractionJob).set({ status: "completed", errorCode: null }).where(eq(extractionJob.id, job.id));
  });
}
export async function fail(db: Db, capability: string, retryable = false, code?: unknown) {
  const { job } = await authorized(db, capability);
  const delay = Math.min(30 * 2 ** Math.min(Math.max(job.attempts - 1, 0), 6), 1800);
  const reason = publicFailureCode(code);
  await asUser(db, job.userId, tx => tx.update(extractionJob).set({ status: retryable ? "queued" : "failed",
    errorCode: retryable ? (reason === "processing_failed" ? "service_unavailable_retrying" : `${reason}_retrying`) : reason, grantHash: null, claimId: null, deadlineAt: null,
    nextAttemptAt: new Date(Date.now() + delay * 1000) }).where(and(eq(extractionJob.id, job.id), eq(extractionJob.status, "running"), eq(extractionJob.grantHash, hash(capability)))));
}
