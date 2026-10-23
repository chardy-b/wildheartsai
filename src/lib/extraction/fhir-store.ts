import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/types";
import { extractionJob, extractionRun, wildcardFile } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import { hmacFor, unsealField, userKeysFor } from "@/lib/crypto/user-keys";
import { fileMetadata } from "@/lib/wildcards-store";
import { resultSchema } from "./contracts";
import { documentFhir } from "./fhir";

export class DocumentFhirError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export async function loadDocumentFhir(db: Db, kek: Buffer, userId: string, fileId: string, origin: string, runId?: string) {
  const file = await fileMetadata(db, kek, userId, fileId);
  if (!file || file.status !== "ready") return null;
  return asUser(db, userId, async tx => {
    // Recheck readiness under a lock so deletion cannot race loading the result.
    const [source] = await tx.select({ contentFingerprint: wildcardFile.contentFingerprint }).from(wildcardFile)
      .where(and(eq(wildcardFile.id, fileId), eq(wildcardFile.userId, userId), eq(wildcardFile.status, "ready"))).for("share");
    if (!source) return null;
    const runs = await tx.select({ id: extractionRun.id, method: extractionRun.method, createdAt: extractionRun.createdAt }).from(extractionRun)
      .innerJoin(extractionJob, eq(extractionRun.id, extractionJob.id))
      .where(and(eq(extractionRun.fileId, fileId), eq(extractionRun.userId, userId), eq(extractionJob.status, "completed")))
      .orderBy(desc(extractionRun.createdAt), desc(extractionRun.id)).limit(100);
    const selectedId = runId ?? runs[0]?.id;
    const [selected] = selectedId ? await tx.select().from(extractionRun).innerJoin(extractionJob, eq(extractionRun.id, extractionJob.id))
      .where(and(eq(extractionRun.id, selectedId), eq(extractionRun.fileId, fileId), eq(extractionRun.userId, userId), eq(extractionJob.status, "completed"))).limit(1) : [];
    if (selectedId && !selected?.extraction_run.sealedResult) return null;
    const row = selected?.extraction_run;
    const keys = row ? await userKeysFor(tx, kek, userId, new Date()) : null;
    const result = row?.sealedResult && keys ? resultSchema.parse(JSON.parse(unsealField(keys, row.sealedResult,
      { table: "extraction_run", rowId: row.id, field: "result" }))) : null;
    if (result && keys && source.contentFingerprint && source.contentFingerprint !== hmacFor(keys, `document-content:v1:${result.sourceSha256}`)) {
      throw new DocumentFhirError(409, "This extraction does not match the original file. Queue a new extraction before viewing its FHIR results.");
    }
    const run = row && result ? { id: row.id, createdAt: row.createdAt.toISOString(), result } : undefined;
    const preview = documentFhir({ file, sourceUrl: new URL(`/api/wildcards/${file.id}`, origin).href, run });
    if (result && !source.contentFingerprint) preview.warnings.push("This older file has no verified content fingerprint. Source integrity needs review.");
    return { file, runs: runs.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })),
      selectedRunId: run?.id ?? null, method: result?.method ?? null, preview };
  });
}
