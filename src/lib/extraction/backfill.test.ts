import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { extractionJob, session } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import { listFiles, storeFile } from "@/lib/wildcards-store";
import { authorized, backfill, cancel, claim, enqueue, fail, finish, processingProgress, rerun, workerConfig } from "./store";

describe("durable bounded backfill", () => {
  it("snapshots only owned unprocessed files, survives duplicate requests and admits at most20 jobs", async () => {
    const db = await createTestDb(), kek = randomBytes(32), owner = "backfill_owner", other = "backfill_other", sid = randomUUID();
    await createTestUser(db, owner); await createTestUser(db, other);
    await db.insert(session).values({ id: sid, userId: owner, token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000), updatedAt: new Date() });
    const blobs = new Map<string, Buffer>();
    const objects = { async put(k: string, b: Buffer) { blobs.set(k, b); }, async get(k: string) { return blobs.get(k)!; }, async delete(k: string) { blobs.delete(k); } };
    for (let i = 0; i < 23; i++) await storeFile(db, kek, owner, `synthetic-${i}.txt`, Buffer.from(`Synthetic content ${i}`), objects);
    await storeFile(db, kek, other, "other.txt", Buffer.from("Synthetic other"), objects);
    await expect(backfill(db, kek, other, sid)).rejects.toThrow("inactive_session");
    expect(await backfill(db, kek, owner, sid)).toEqual({ enrolled: 23, upgraded: 0, resumed: 0, batchSize: 20 });
    expect(await backfill(db, kek, owner, sid)).toEqual({ enrolled: 0, upgraded: 0, resumed: 0, batchSize: 20 });
    expect(await processingProgress(db, owner)).toMatchObject({ counts: { waiting: 23, not_started: 0 }, durablePending: 23 });
    expect((await processingProgress(db, other)).counts.not_started).toBe(1);
    expect(await claim(db, randomUUID(), "synthetic-key")).toBeNull(); // older coordinators cannot admit the new pipeline
    const request = randomUUID(), job = (await claim(db, request, "synthetic-key", true))!;
    expect((await processingProgress(db, owner)).counts).toMatchObject({ waiting: 3, queued: 19, running: 1 });
    expect(await workerConfig(db, kek, job.capability)).toMatchObject({ method: "native", pipeline: "native-ocr/v1", attempt: 1 });
    expect(await claim(db, request, "synthetic-key", true)).toMatchObject({ id: job.id });
    expect((await processingProgress(db, owner)).counts.waiting).toBe(3);
    await finish(db, kek, job.capability, { version: 1, sourceSha256: "a".repeat(64), method: "native", manifest: { pipeline: "native-ocr/v1" }, elapsedMs: 1,
      pages: [{ page: 1, text: "Synthetic", words: [], tables: [], figures: [], foregroundCoverage: null, redaction: { rules: [], openmed: [], combined: [], text: "Synthetic" } }],
      totalPages: 1, summary: "", summaryStatus: "withheld", ageAtEncounter: null, measurements: [], warnings: [] });
    expect(await claim(db, randomUUID(), "synthetic-key", true)).not.toBeNull();
    expect((await processingProgress(db, owner)).counts).toMatchObject({ waiting: 2, queued: 19, running: 1, completed: 1 });
    const [child] = await rerun(db, kek, owner, sid, job.id);
    await asUser(db, owner, tx => tx.update(extractionJob).set({ status: "cancelled", grantHash: null }).where(and(eq(extractionJob.userId, owner), ne(extractionJob.id, child), ne(extractionJob.status, "completed"))));
    const rerunClaim = (await claim(db, randomUUID(), "synthetic-key", true))!;
    expect(rerunClaim.id).toBe(child);
    expect(await workerConfig(db, kek, rerunClaim.capability)).toMatchObject({ pipeline: "native-ocr/v1", parentRunId: job.id });
    // Logout cannot revoke durable authorization or prevent retry/recovery.
    await db.delete(session).where(eq(session.id, sid));
    expect(await workerConfig(db, kek, rerunClaim.capability)).toMatchObject({ pipeline: "native-ocr/v1" });
    await fail(db, rerunClaim.capability, true);
    await expect(authorized(db, rerunClaim.capability)).rejects.toThrow();
    await asUser(db, owner, tx => tx.update(extractionJob).set({ nextAttemptAt: new Date(0) }).where(eq(extractionJob.id, child)));
    const retry = (await claim(db, randomUUID(), "synthetic-key", true))!;
    expect(retry).toMatchObject({ id: child, attempt: 2 });
    await finish(db, kek, retry.capability, { version: 1, sourceSha256: "a".repeat(64), method: "native", manifest: { pipeline: "native-ocr/v1" }, elapsedMs: 1,
      pages: [{ page: 1, text: "Synthetic", words: [], tables: [], figures: [], foregroundCoverage: null, redaction: { rules: [], openmed: [], combined: [], text: "Synthetic" } }],
      totalPages: 1, summary: "", summaryStatus: "withheld", ageAtEncounter: null, measurements: [], warnings: [] });
    expect(await claim(db, randomUUID(), "synthetic-key", true)).toBeNull();
    const jobs = await asUser(db, owner, tx => tx.select().from(extractionJob));
    expect(jobs.filter(j => j.status !== "completed").every(j => j.status === "cancelled")).toBe(true);
  });
  it("upgrades only legacy backfills, explicitly resumes cancellations, and preserves owner cancellation and session-bound experiments", async () => {
    const db = await createTestDb(), kek = randomBytes(32), owner = "legacy_backfill", sid = randomUUID();
    await createTestUser(db, owner);
    await db.insert(session).values({ id: sid, userId: owner, token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000), updatedAt: new Date() });
    const objects = { async put() {}, async get() { return Buffer.from("Synthetic"); }, async delete() {} };
    for (let i = 0; i < 4; i++) await storeFile(db, kek, owner, `legacy-${i}.txt`, Buffer.from("Synthetic"), objects);
    await backfill(db, kek, owner, sid);
    const jobs = await asUser(db, owner, tx => tx.select().from(extractionJob));
    await asUser(db, owner, async tx => {
      await tx.update(extractionJob).set({ durable: false }).where(eq(extractionJob.userId, owner));
      await tx.update(extractionJob).set({ status: "cancelled" }).where(eq(extractionJob.id, jobs[1].id));
      await tx.update(extractionJob).set({ status: "failed", errorCode: "pdf_page_limit" }).where(eq(extractionJob.id, jobs[3].id));
    });
    await cancel(db, owner, jobs[2].id);
    await storeFile(db, kek, owner, "experiment.txt", Buffer.from("Synthetic experiment"), objects);
    const file = (await listFiles(db, kek, owner)).find(f => f.name === "experiment.txt")!;
    const [experiment] = await enqueue(db, kek, owner, sid, { fileIds: [file.id], methods: ["native"] });
    expect(await backfill(db, kek, owner, sid)).toMatchObject({ enrolled: 0, upgraded: 1, resumed: 0 });
    expect(await backfill(db, kek, owner, sid, true)).toMatchObject({ enrolled: 0, upgraded: 0, resumed: 1 });
    expect(await backfill(db, kek, owner, sid, true)).toMatchObject({ enrolled: 0, upgraded: 0, resumed: 0 });
    await db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.id, sid));
    const job = (await claim(db, randomUUID(), "synthetic-key", true))!;
    expect(await workerConfig(db, kek, job.capability)).toMatchObject({ pipeline: "native-ocr/v1" });
    expect((await asUser(db, owner, tx => tx.select().from(extractionJob).where(eq(extractionJob.id, experiment))))[0].status).toBe("cancelled");
    expect((await asUser(db, owner, tx => tx.select().from(extractionJob).where(eq(extractionJob.id, jobs[2].id))))[0].status).toBe("cancelled");
    expect((await asUser(db, owner, tx => tx.select().from(extractionJob).where(eq(extractionJob.id, jobs[3].id))))[0].status).toBe("failed");
    await cancel(db, owner, job.id);
    await expect(authorized(db, job.capability)).rejects.toThrow();
  });
});
