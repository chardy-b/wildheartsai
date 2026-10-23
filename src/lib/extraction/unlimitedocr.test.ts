import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { extractionRun, session } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import type { Db } from "@/lib/db/types";
import { listFiles, storeFile } from "@/lib/wildcards-store";
import { cancel, claim, enabledMethods, enqueue, finish, listRuns, workerConfig } from "./store";
import { extractionMethod } from "./presentation";
import type { ExtractionResult } from "./contracts";

let db: Db, fileId: string;
const kek = randomBytes(32), owner = "unlimited_owner", other = "unlimited_other", sessionId = "unlimited_session";
const blobs = new Map<string, Buffer>();
const objects = { async put(k: string, b: Buffer) { blobs.set(k, b); }, async get(k: string) { return blobs.get(k)!; }, async delete(k: string) { blobs.delete(k); } };

beforeAll(async () => {
  db = await createTestDb();
  await createTestUser(db, owner); await createTestUser(db, other);
  await db.insert(session).values({ id: sessionId, userId: owner, token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000), updatedAt: new Date() });
  await storeFile(db, kek, owner, "synthetic.txt", Buffer.from("Synthetic 13.5 g/dL"), objects);
  fileId = (await listFiles(db, kek, owner))[0].id;
});
afterEach(() => vi.unstubAllEnvs());

describe("Unlimited OCR uses the existing extraction queue", () => {
  it("remains opt-in and revokes the normal scoped grant on cancellation", async () => {
    vi.stubEnv("EXTRACTION_METHODS", "native,tesseract");
    expect(enabledMethods()).not.toContain("unlimitedocr");
    await expect(enqueue(db, kek, owner, sessionId, { fileIds: [fileId], methods: ["unlimitedocr"] })).rejects.toThrow("method_unavailable");
    vi.stubEnv("EXTRACTION_METHODS", "native,tesseract,unlimitedocr");
    await enqueue(db, kek, owner, sessionId, { fileIds: [fileId], methods: ["unlimitedocr"] });
    const job = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
    expect(await workerConfig(db, kek, job.capability)).toMatchObject({ method: "unlimitedocr" });
    await cancel(db, owner, job.id);
    await expect(workerConfig(db, kek, job.capability)).rejects.toThrow();
  });

  it("preserves method identity, ownership and encrypted immutable results", async () => {
    vi.stubEnv("EXTRACTION_METHODS", "native,tesseract,unlimitedocr");
    await expect(enqueue(db, kek, other, sessionId, { fileIds: [fileId], methods: ["unlimitedocr"] })).rejects.toThrow();
    await enqueue(db, kek, owner, sessionId, { fileIds: [fileId], methods: ["unlimitedocr"] });
    const job = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
    const text = "Synthetic 13.5 g/dL";
    const result: ExtractionResult = { version: 1, method: "unlimitedocr", sourceSha256: "a".repeat(64),
      manifest: { unlimited_ocr_revision: "b".repeat(40), unlimited_ocr_fingerprint: "c".repeat(64) }, elapsedMs: 1,
      pages: [{ page: 1, text, words: [], tables: [], figures: [], foregroundCoverage: null,
        redaction: { rules: [], openmed: [], combined: [], text } }], totalPages: 1,
      summary: "", summaryStatus: "withheld", ageAtEncounter: null, measurements: [], warnings: [] };
    await expect(finish(db, kek, job.capability, { ...result, method: "tesseract" })).rejects.toThrow("wrong_method");
    await finish(db, kek, job.capability, result);
    const [stored] = await asUser(db, owner, tx => tx.select().from(extractionRun).where(eq(extractionRun.id, job.id)));
    expect(stored.sealedResult).not.toContain(text);
    expect((await listRuns(db, kek, owner, fileId, job.id)).find(r => r.id === job.id)?.result).toEqual(result);
    expect(await listRuns(db, kek, other, fileId, job.id)).toEqual([]);
    expect(extractionMethod("unlimitedocr", "application/pdf")).toContain("Unlimited OCR");
  });
});
