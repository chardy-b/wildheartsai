import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { extractionJob, session } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import { storeFile } from "@/lib/wildcards-store";
import { backfill, claim, finish, processingProgress, rerun, workerConfig } from "./store";

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
    expect(await backfill(db, kek, owner, sid)).toEqual({ enrolled: 23, batchSize: 20 });
    expect(await backfill(db, kek, owner, sid)).toEqual({ enrolled: 0, batchSize: 20 });
    expect((await processingProgress(db, owner)).counts).toMatchObject({ waiting: 23, not_started: 0 });
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
    // A coordinator restart/session revocation cannot resurrect pending work.
    await db.delete(session).where(eq(session.id, sid));
    expect(await claim(db, randomUUID(), "synthetic-key")).toBeNull();
    const jobs = await asUser(db, owner, tx => tx.select().from(extractionJob));
    expect(jobs.filter(j => j.status !== "completed").every(j => j.status === "cancelled")).toBe(true);
  });
});
