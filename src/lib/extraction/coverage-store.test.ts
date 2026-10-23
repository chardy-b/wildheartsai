import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, createTestUser } from "@/test/db";
import { asUser } from "@/lib/db/rls";
import { extractionRun, session } from "@/lib/db/schema";
import { listFiles, storeFile } from "@/lib/wildcards-store";
import { claim, enqueue, fileCoverage, finish } from "./store";
import type { ExtractionResult } from "./contracts";

describe("owner-scoped coverage storage", () => {
  it("decrypts only requested owned results, combines latest completed methods and returns no text or masks", async () => {
    const db = await createTestDb(), kek = randomBytes(32);
    const owner = await createTestUser(db, "coverage_owner"), other = await createTestUser(db, "coverage_other");
    const sessionId = randomUUID();
    await db.insert(session).values({ id: sessionId, userId: owner, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000), updatedAt: new Date() });
    const blobs = new Map<string, Buffer>();
    const objects = { async put(k: string, b: Buffer) { blobs.set(k, b); }, async get(k: string) { return blobs.get(k)!; }, async delete(k: string) { blobs.delete(k); } };
    await storeFile(db, kek, owner, "synthetic.txt", Buffer.from("Synthetic private contents"), objects);
    const fileId = (await listFiles(db, kek, owner))[0].id;
    async function complete(method: "native" | "tesseract", box?: [number, number, number, number]) {
      const [id] = await enqueue(db, kek, owner, sessionId, { fileIds: [fileId], methods: [method] });
      const grant = (await claim(db, randomUUID(), "synthetic-coverage-grant"))!;
      expect(grant.id).toBe(id);
      const result: ExtractionResult = { version: 1, method, sourceSha256: "a".repeat(64), manifest: {}, elapsedMs: 0,
        totalPages: 1, summary: "", summaryStatus: "withheld", measurements: [], warnings: [], ageAtEncounter: null,
        pages: [{ page: 1, text: "Synthetic private contents", words: box ? [{ text: "private", box }] : [], figures: [], tables: [], foregroundCoverage: null,
          redaction: { rules: [], openmed: [], combined: [], text: "Synthetic" },
          diagnostics: { version: 1, textSource: method, foregroundPixels: 4, coveredForegroundPixels: 0, sampleWidth: 4, sampleHeight: 1,
            uncoveredRegions: [], lowConfidenceWords: 0, confidenceWords: 0, imageRegions: 0,
            foregroundMask: { width: 4, height: 1, bits: "Dw==" } } }] };
      await finish(db, kek, grant.capability, result);
      return id;
    }
    const first = await complete("native", [0, 0, .5, 1]);
    await complete("tesseract", [.5, 0, 1, 1]);
    expect((await fileCoverage(db, kek, owner, [fileId])).files[0].coverage).toMatchObject({ identifiedCoverage: 1, unclassifiedCoverage: 0 });
    const latest = await complete("native");
    // Explicit timestamps make latest-method selection deterministic even on fast test clocks.
    await asUser(db, owner, tx => tx.update(extractionRun).set({ createdAt: new Date(Date.now() + 1000) }).where(eq(extractionRun.id, latest)));
    const summary = await fileCoverage(db, kek, owner, [fileId]);
    expect(summary.files[0].coverage).toMatchObject({ identifiedCoverage: .5, unclassifiedCoverage: .5 });
    expect(summary.files[0].coverage).not.toHaveProperty("pages");
    expect(JSON.stringify(summary)).not.toMatch(/private|Dw==|foregroundMask/);
    const detail = await fileCoverage(db, kek, owner, [fileId], true);
    expect(detail.files[0].coverage).toHaveProperty("pages.0.uncovered", [[0, 0, .5, 1]]);
    expect(await fileCoverage(db, kek, other, [fileId], true)).toEqual({ files: [] });
    expect(await fileCoverage(db, kek, owner, [randomUUID()])).toEqual({ files: [] });
    const [stored] = await asUser(db, owner, tx => tx.select().from(extractionRun).where(eq(extractionRun.id, first)));
    expect(stored.sealedResult).not.toContain("foregroundMask");
  });
});
