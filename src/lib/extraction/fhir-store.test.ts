import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, createTestUser } from "@/test/db";
import type { Db } from "@/lib/db/types";
import { extractionJob, extractionRun, session, wildcardFile } from "@/lib/db/schema";
import { deleteFile, listFiles, storeFile } from "@/lib/wildcards-store";
import { enqueue, claim, finish } from "./store";
import { loadDocumentFhir } from "./fhir-store";
import type { ExtractionResult } from "./contracts";

let db: Db;
const kek = randomBytes(32), owner = "fhir_owner", other = "fhir_other", sessionId = "fhir_session";
const text = "Synthetic marker 100 mg/dL 2024-01-01";
const sha = createHash("sha256").update(text).digest("hex");
const result: ExtractionResult = { version: 1, sourceSha256: sha, method: "native", manifest: {}, elapsedMs: 5,
  pages: [{ page: 1, text, words: [], tables: [], figures: [], foregroundCoverage: null, redaction: { rules: [], openmed: [], combined: [], text } }], totalPages: 1,
  summary: "", summaryStatus: "withheld", ageAtEncounter: null, warnings: [], measurements: [
    { name: "Synthetic marker", value: "100", unit: "mg/dL", date: "2024-01-01", range: "", page: 1, evidence: text },
  ] };
const objects = { async put() {}, async get() { return Buffer.from(text); }, async delete() {} };
let fileId: string, runId: string;
beforeAll(async () => {
  db = await createTestDb(); await createTestUser(db, owner); await createTestUser(db, other);
  await db.insert(session).values({ id: sessionId, userId: owner, token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000), updatedAt: new Date() });
  await storeFile(db, kek, owner, "synthetic.txt", Buffer.from(text), objects);
  fileId = (await listFiles(db, kek, owner))[0].id;
  [runId] = await enqueue(db, kek, owner, sessionId, { fileIds: [fileId], methods: ["native"] });
  const grant = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
  await finish(db, kek, grant.capability, result);
});

describe("owner-scoped FHIR previews", () => {
  it("loads a matching completed run and prevents cross-owner and cross-document selection", async () => {
    const loaded = await loadDocumentFhir(db, kek, owner, fileId, "https://app.test", runId);
    expect(loaded?.selectedRunId).toBe(runId);
    expect(loaded?.preview.measurements).toHaveLength(1);
    expect(await loadDocumentFhir(db, kek, other, fileId, "https://app.test", runId)).toBeNull();
    expect(await loadDocumentFhir(db, kek, owner, fileId, "https://app.test", randomUUID())).toBeNull();
    await storeFile(db, kek, owner, "second.txt", Buffer.from("different source"), objects);
    const second = (await listFiles(db, kek, owner)).find(f => f.id !== fileId)!;
    expect(await loadDocumentFhir(db, kek, owner, second.id, "https://app.test", runId)).toBeNull();
    expect((await loadDocumentFhir(db, kek, owner, second.id, "https://app.test"))?.preview.bundle.entry).toHaveLength(1);
  });

  it("never loads a running extraction as completed", async () => {
    const [queued] = await enqueue(db, kek, owner, sessionId, { fileIds: [fileId], methods: ["native"] });
    expect(await loadDocumentFhir(db, kek, owner, fileId, "https://app.test", queued)).toBeNull();
    expect((await loadDocumentFhir(db, kek, owner, fileId, "https://app.test"))?.selectedRunId).toBe(runId);
    await db.update(extractionJob).set({ status: "cancelled" }).where(eq(extractionJob.id, queued));
  });

  it("rejects a source hash mismatch and makes deletion revoke every preview", async () => {
    const [id] = await enqueue(db, kek, owner, sessionId, { fileIds: [fileId], methods: ["native"] });
    const grant = (await claim(db, randomUUID(), "synthetic-grant-key"))!;
    expect(grant.id).toBe(id);
    await finish(db, kek, grant.capability, { ...result, sourceSha256: "a".repeat(64) });
    await expect(loadDocumentFhir(db, kek, owner, fileId, "https://app.test", id)).rejects.toMatchObject({ status: 409 });
    // An explicitly selected older valid run remains usable.
    expect((await loadDocumentFhir(db, kek, owner, fileId, "https://app.test", runId))?.preview.measurements).toHaveLength(1);
    await deleteFile(db, owner, fileId, objects);
    expect(await loadDocumentFhir(db, kek, owner, fileId, "https://app.test", runId)).toBeNull();
    expect(await db.select().from(extractionRun).where(eq(extractionRun.id, runId))).toEqual([]);
    expect(await db.select().from(wildcardFile).where(eq(wildcardFile.id, fileId))).toEqual([]);
  });
});
