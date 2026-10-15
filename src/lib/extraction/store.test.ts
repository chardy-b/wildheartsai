import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { extractionJob, extractionRun, session } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import type { Db } from "@/lib/db/types";
import { deleteFile, listFiles, storeFile } from "@/lib/wildcards-store";
import { authorized, cancel, claim, enqueue, fail, finish, listRuns, references, saveReference } from "./store";
import type { ExtractionResult } from "./contracts";

const result: ExtractionResult = { version: 1, sourceSha256: "a".repeat(64), method: "native", manifest: { worker: "synthetic" }, elapsedMs: 10,
  pages: [{ page: 1, text: "Jane Example glucose 100 mg/dL", words: [], tables: [], figures: [], foregroundCoverage: null,
    redaction: { rules: [], openmed: [], combined: [], text: "glucose 100 mg/dL" } }], totalPages: 1,
  summary: "Glucose was 100 mg/dL.", summaryStatus: "accepted", ageAtEncounter: null, measurements: [], warnings: [] };

let db: Db;
const kek = randomBytes(32), owner = "extraction_alice", other = "extraction_bob", sessionId = "extraction_session";
const blobs = new Map<string, Buffer>();
const objects = { async put(k: string, b: Buffer) { blobs.set(k, b); }, async get(k: string) { return blobs.get(k)!; }, async delete(k: string) { blobs.delete(k); } };
let fileId: string;
beforeAll(async () => {
  db = await createTestDb(); await createTestUser(db, owner); await createTestUser(db, other);
  await db.insert(session).values({ id: sessionId, userId: owner, token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000), updatedAt: new Date() });
  await storeFile(db, kek, owner, "synthetic.txt", Buffer.from("Jane Example glucose 100 mg/dL"), objects);
  fileId = (await listFiles(db, kek, owner))[0].id;
});
describe("web-owned extraction custody", () => {
  it("queues only owned ready documents and hides content from the other account", async () => {
    await expect(enqueue(db, kek, other, sessionId, { fileIds: [fileId], methods: ["native"] })).rejects.toThrow();
    const ids = await enqueue(db, kek, owner, sessionId, { fileIds: [fileId], methods: ["native"] });
    expect(ids).toHaveLength(1);
    expect(await listRuns(db, kek, other, fileId)).toEqual([]);
    const labels = { version: 1, split: "train", pages: [{ page: 1, text: "Jane Example", pii: [{ start: 0, end: 12, label: "NAME" }] }], measurements: [], measurementsComplete: false };
    const referenceId = await saveReference(db, kek, owner, fileId, labels);
    expect(await references(db, kek, other, fileId)).toEqual([]);
    expect((await references(db, kek, owner, fileId))[0].labels).toBeNull();
    expect((await references(db, kek, owner, fileId, referenceId))[0].labels).toEqual(labels);
  });
  it("replays claims and completions without duplicate jobs, encrypts results, and rejects conflicting writes", async () => {
    const requestId = randomUUID();
    const run = (await claim(db, requestId, "synthetic-grant-key"))!;
    expect(await claim(db, requestId, "synthetic-grant-key")).toEqual(run);
    expect(Object.keys(run).sort()).toEqual(["capability", "id"]);
    await finish(db, kek, run.capability, result);
    await finish(db, kek, run.capability, result);
    await expect(finish(db, kek, run.capability, { ...result, summary: "Changed" })).rejects.toThrow("conflicting_result");
    const [raw] = await asUser(db, owner, tx => tx.select().from(extractionRun).where(eq(extractionRun.id, run.id)));
    expect(raw.sealedResult).not.toContain("Jane");
    expect((await listRuns(db, kek, owner, fileId, run.id))[0].result).toEqual(result);
    await expect(authorized(db, run.capability)).rejects.toThrow();
  });
  it("persists outage backoff, revokes old attempts, and lets other work proceed", async () => {
    await enqueue(db, kek, owner, sessionId, { fileIds: [fileId], methods: ["native", "tesseract"] });
    const a = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
    await fail(db, a.capability, true);
    await expect(authorized(db, a.capability)).rejects.toThrow();
    const [delayed] = await asUser(db, owner, tx => tx.select().from(extractionJob).where(eq(extractionJob.id, a.id)));
    expect(delayed.status).toBe("queued"); expect(delayed.attempts).toBe(1);
    expect(delayed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    const b = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
    expect(b.id).not.toBe(a.id);
    await cancel(db, owner, b.id);
    expect(await claim(db, randomUUID(), "synthetic-grant-key")).toBeNull();
    await asUser(db, owner, tx => tx.update(extractionJob).set({ nextAttemptAt: new Date(0) }).where(eq(extractionJob.id, a.id)));
    const retry = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
    expect(retry.id).toBe(a.id); expect(retry.capability).not.toBe(a.capability);
    await expect(finish(db, kek, a.capability, result)).rejects.toThrow();
    await finish(db, kek, retry.capability, result);
  });
  it("recovers expired VPS attempts after a restart and preserves terminal failures", async () => {
    await enqueue(db, kek, owner, sessionId, { fileIds: [fileId], methods: ["native"] });
    const a = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
    await asUser(db, owner, tx => tx.update(extractionJob).set({ deadlineAt: new Date(0) }).where(eq(extractionJob.id, a.id)));
    expect(await claim(db, randomUUID(), "synthetic-grant-key")).toBeNull();
    await expect(authorized(db, a.capability)).rejects.toThrow();
    await asUser(db, owner, tx => tx.update(extractionJob).set({ nextAttemptAt: new Date(0), attempts: 50 }).where(eq(extractionJob.id, a.id)));
    const retry = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
    await fail(db, retry.capability, true);
    const [delayed] = await asUser(db, owner, tx => tx.select().from(extractionJob).where(eq(extractionJob.id, a.id)));
    expect(delayed.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(1790_000);
    expect(delayed.nextAttemptAt.getTime() - Date.now()).toBeLessThanOrEqual(1800_000);
    await asUser(db, owner, tx => tx.update(extractionJob).set({ nextAttemptAt: new Date(0) }).where(eq(extractionJob.id, a.id)));
    const final = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
    await fail(db, final.capability);
    expect(await claim(db, randomUUID(), "synthetic-grant-key")).toBeNull();
    expect((await listRuns(db, kek, owner, fileId)).find(r => r.id === a.id)?.status).toBe("failed");
  });
  it("revokes access on cancel and session deletion", async () => {
    await enqueue(db, kek, owner, sessionId, { fileIds: [fileId], methods: ["native", "tesseract"] });
    const a = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
    expect(await claim(db, randomUUID(), "synthetic-grant-key")).toMatchObject({ id: a.id, capability: a.capability, resumed: true });
    expect(await cancel(db, other, a.id)).toBe(false);
    expect(await cancel(db, owner, a.id)).toBe(true);
    await expect(authorized(db, a.capability)).rejects.toThrow();
    const b = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
    await db.delete(session).where(eq(session.id, sessionId));
    await expect(authorized(db, b.capability)).rejects.toThrow();
    await expect(finish(db, kek, b.capability, { ...result, method: "tesseract" })).rejects.toThrow();
    await deleteFile(db, owner, fileId, objects);
    expect(await listRuns(db, kek, owner, fileId)).toEqual([]);
  });
});
