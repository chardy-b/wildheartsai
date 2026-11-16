import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult } from "@/lib/extraction/contracts";
import { deleteFile, fileMetadata, listFiles, storeFile } from "../src/data/documents";
import { authorized, cancel, claim, enqueue, extractionAudit, fail, finish, listRuns, processingProgress, references, rerun, saveReference, workerConfig } from "../src/data/extraction";
import { fileObjects } from "../src/data/file-objects";
import { forUser } from "../src/data/scope";
import * as s from "../src/db/schema";
import type { Bindings, Secrets } from "../src/env";
import { clearAll, db, person, recordsKey } from "./helpers";

// Ported from src/lib/extraction/store.test.ts: the same custody rules, on D1, with the claim and
// enqueue locks as Durable Objects. Made-up document and result only.
const result: ExtractionResult = {
  version: 1, sourceSha256: "a".repeat(64), method: "native", manifest: { worker: "synthetic" }, elapsedMs: 10,
  pages: [{ page: 1, text: "Jane Example glucose 100 mg/dL", words: [], tables: [], figures: [], foregroundCoverage: null, redaction: { rules: [], openmed: [], combined: [], text: "glucose 100 mg/dL" } }],
  totalPages: 1, summary: "Glucose was 100 mg/dL.", summaryStatus: "accepted", ageAtEncounter: null, measurements: [], warnings: [],
};
const bindings = env as unknown as Bindings;
const config = { EXTRACTION_METHODS: "native,tesseract" } as Secrets;
const KEY = "synthetic-grant-key-at-least-32-characters";
const owner = "extraction_alice";
const sessionId = "extraction_session";
const kek = recordsKey;
const objects = fileObjects(env.FILES);
const ownerScope = forUser(db, owner);
const otherScope = forUser(db, "extraction_bob");
let fileId: string;

const job = async (id: string) => (await db.select().from(s.extractionJob).where(eq(s.extractionJob.id, id)))[0];
const setJob = (id: string, values: Partial<typeof s.extractionJob.$inferInsert>) => db.update(s.extractionJob).set(values).where(eq(s.extractionJob.id, id));

beforeAll(async () => {
  await clearAll();
  await person(owner);
  await person("extraction_bob");
  await db.insert(s.session).values({ id: sessionId, userId: owner, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 3600_000), updatedAt: new Date() });
  await storeFile(ownerScope, kek, "synthetic.txt", Buffer.from("Jane Example glucose 100 mg/dL"), objects);
  fileId = (await listFiles(ownerScope, kek))[0].id;
});

describe("extraction custody on D1", () => {
  it("queues only owned ready documents and hides content from the other account", async () => {
    expect(await processingProgress(ownerScope)).toMatchObject({ documents: 1, counts: { not_started: 1 }, files: [] });
    await expect(enqueue(bindings, config, otherScope, kek, sessionId, { fileIds: [fileId], methods: ["native"] })).rejects.toThrow();
    const ids = await enqueue(bindings, config, ownerScope, kek, sessionId, { fileIds: [fileId], methods: ["native"] });
    expect(ids).toHaveLength(1);
    expect(await listRuns(otherScope, kek, fileId)).toEqual([]);
    const labels = { version: 1, split: "train", pages: [{ page: 1, text: "Jane Example", pii: [{ start: 0, end: 12, label: "NAME" }] }], measurements: [], measurementsComplete: false };
    const referenceId = await saveReference(ownerScope, kek, fileId, labels);
    expect(await references(otherScope, kek, fileId)).toEqual([]);
    expect((await references(ownerScope, kek, fileId))[0].labels).toBeNull();
    expect((await references(ownerScope, kek, fileId, referenceId))[0].labels).toEqual(labels);
    expect(await fileMetadata(otherScope, kek, fileId)).toBeNull();
    expect(await processingProgress(otherScope)).toMatchObject({ documents: 0, files: [] });
    expect(await processingProgress(ownerScope)).toMatchObject({ documents: 1, counts: { not_started: 0, queued: 1 }, files: [{ fileId, status: "queued" }] });
  });

  it("replays claims and completions without duplicate jobs, encrypts results, and rejects conflicting writes", async () => {
    const requestId = crypto.randomUUID();
    const run = (await claim(bindings, db, requestId, KEY))!;
    expect(await claim(bindings, db, requestId, KEY)).toEqual(run);
    expect(Object.keys(run).sort()).toEqual(["attempt", "capability", "id"]);
    await finish(db, kek, run.capability, result);
    await finish(db, kek, run.capability, result);
    await expect(finish(db, kek, run.capability, { ...result, summary: "Changed" })).rejects.toThrow("conflicting_result");
    const [raw] = await db.select().from(s.extractionRun).where(eq(s.extractionRun.id, run.id));
    expect(raw.sealedResult).not.toContain("Jane");
    expect((await listRuns(ownerScope, kek, fileId, run.id))[0].result).toEqual(result);
    await expect(authorized(db, run.capability)).rejects.toThrow();
    expect((await extractionAudit(otherScope, kek)).rows).toEqual([]);
    expect((await extractionAudit(ownerScope, kek)).rows[0]).toMatchObject({ runId: run.id, method: "native", reviewedPages: 1 });
    await expect(rerun(bindings, config, otherScope, kek, sessionId, run.id)).rejects.toThrow();
    const [rerunId] = await rerun(bindings, config, ownerScope, kek, sessionId, run.id);
    const child = (await claim(bindings, db, crypto.randomUUID(), KEY))!;
    expect(child.id).toBe(rerunId);
    expect(await workerConfig(db, kek, child.capability)).toMatchObject({ parentRunId: run.id, expectedEnvironment: "unknown" });
    await cancel(ownerScope, child.id);
  });

  it("persists outage backoff, revokes old attempts, and lets other work proceed", async () => {
    await enqueue(bindings, config, ownerScope, kek, sessionId, { fileIds: [fileId], methods: ["native", "tesseract"] });
    const a = (await claim(bindings, db, crypto.randomUUID(), KEY))!;
    await fail(db, a.capability, true);
    await expect(authorized(db, a.capability)).rejects.toThrow();
    const delayed = await job(a.id);
    expect(delayed.status).toBe("queued");
    expect(delayed.attempts).toBe(1);
    expect(delayed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    const b = (await claim(bindings, db, crypto.randomUUID(), KEY))!;
    expect(b.id).not.toBe(a.id);
    await cancel(ownerScope, b.id);
    expect(await claim(bindings, db, crypto.randomUUID(), KEY)).toBeNull();
    await setJob(a.id, { nextAttemptAt: new Date(0) });
    const retry = (await claim(bindings, db, crypto.randomUUID(), KEY))!;
    expect(retry.id).toBe(a.id);
    expect(retry.capability).not.toBe(a.capability);
    await expect(finish(db, kek, a.capability, result)).rejects.toThrow();
    await finish(db, kek, retry.capability, result);
  });

  it("recovers expired VPS attempts after a restart and preserves terminal failures", async () => {
    await enqueue(bindings, config, ownerScope, kek, sessionId, { fileIds: [fileId], methods: ["native"] });
    const a = (await claim(bindings, db, crypto.randomUUID(), KEY))!;
    await setJob(a.id, { deadlineAt: new Date(0) });
    expect(await claim(bindings, db, crypto.randomUUID(), KEY)).toBeNull();
    await expect(authorized(db, a.capability)).rejects.toThrow();
    await setJob(a.id, { nextAttemptAt: new Date(0), attempts: 50 });
    const retry = (await claim(bindings, db, crypto.randomUUID(), KEY))!;
    await fail(db, retry.capability, true);
    const delayed = await job(a.id);
    expect(delayed.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(1790_000);
    expect(delayed.nextAttemptAt.getTime() - Date.now()).toBeLessThanOrEqual(1800_000);
    await setJob(a.id, { nextAttemptAt: new Date(0) });
    const final = (await claim(bindings, db, crypto.randomUUID(), KEY))!;
    await fail(db, final.capability, false, "pdf_page_limit");
    expect(await claim(bindings, db, crypto.randomUUID(), KEY)).toBeNull();
    const runs = await listRuns(ownerScope, kek, fileId);
    expect(runs.find((r) => r.id === a.id)).toMatchObject({ status: "failed", errorCode: "pdf_page_limit" });
  });

  it("revokes access on cancel and session deletion", async () => {
    await enqueue(bindings, config, ownerScope, kek, sessionId, { fileIds: [fileId], methods: ["native", "tesseract"] });
    const a = (await claim(bindings, db, crypto.randomUUID(), KEY))!;
    expect(await claim(bindings, db, crypto.randomUUID(), KEY)).toMatchObject({ id: a.id, capability: a.capability, resumed: true });
    expect(await cancel(otherScope, a.id)).toBe(false);
    expect(await cancel(ownerScope, a.id)).toBe(true);
    await expect(authorized(db, a.capability)).rejects.toThrow();
    const b = (await claim(bindings, db, crypto.randomUUID(), KEY))!;
    await db.delete(s.session).where(eq(s.session.id, sessionId));
    await expect(authorized(db, b.capability)).rejects.toThrow();
    await expect(finish(db, kek, b.capability, { ...result, method: "tesseract" })).rejects.toThrow();
    await deleteFile(ownerScope, fileId, objects);
    expect(await listRuns(ownerScope, kek, fileId)).toEqual([]);
    expect(await processingProgress(ownerScope)).toMatchObject({ documents: 0, files: [] });
  });

  it("lets enqueues for one person wait for each other instead of overfilling the queue", async () => {
    await db.insert(s.session).values({ id: "session-2", userId: owner, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 3600_000), updatedAt: new Date() });
    await storeFile(ownerScope, kek, "second.txt", Buffer.from("Another made-up note"), objects);
    const [file] = await listFiles(ownerScope, kek);
    // Two simultaneous requests of 41 each: only one fits under the limit of 80 active jobs.
    await db.delete(s.extractionJob);
    const fill = await enqueue(bindings, config, ownerScope, kek, "session-2", { fileIds: [file.id], methods: ["native"] });
    await setJob(fill[0], { status: "queued" });
    const many = { fileIds: [file.id], methods: ["native", "tesseract"] };
    const outcomes = await Promise.allSettled(Array.from({ length: 41 }, () => enqueue(bindings, config, ownerScope, kek, "session-2", many)));
    const active = (await db.select().from(s.extractionJob)).filter((j) => ["queued", "running"].includes(j.status)).length;
    expect(active).toBeLessThanOrEqual(80);
    expect(outcomes.some((o) => o.status === "rejected")).toBe(true);
  });
});
