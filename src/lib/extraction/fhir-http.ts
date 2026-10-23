import "server-only";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { getSession } from "@/lib/session";
import { appUrl } from "@/lib/env";
import { asUser } from "@/lib/db/rls";
import { recordAudit } from "@/lib/audit";
import { fileError, PRIVATE_HEADERS, validFileId } from "@/lib/wildcards-http";
import { DocumentFhirError, loadDocumentFhir } from "./fhir-store";

export async function documentFhirRequest(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return fileError("Sign in to view this document.", 401);
  const { id } = await context.params;
  const query = new URL(request.url).searchParams;
  const runId = query.get("runId") ?? undefined;
  if (!validFileId(id) || (runId !== undefined && !validFileId(runId))) return fileError("Document not found.", 404);
  try {
    const data = await loadDocumentFhir(db, recordsKey(), session.user.id, id, appUrl(), runId);
    if (!data) return fileError("Document not found.", 404);
    const download = query.get("download") === "1";
    if (download) await asUser(db, session.user.id, tx => recordAudit(tx, { userId: session.user.id, action: "export",
      detail: { records: data.preview.bundle.entry.length, document: true } }, new Date()));
    return new Response(JSON.stringify(data.preview.bundle, null, 2), { headers: {
      ...PRIVATE_HEADERS, "Content-Type": "application/fhir+json; charset=utf-8",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="document-${id}.fhir.json"`,
      "Cross-Origin-Resource-Policy": "same-origin",
    } });
  } catch (error) {
    if (error instanceof DocumentFhirError) return fileError(error.message, error.status);
    return fileError("Could not create this document’s FHIR view. Please try again.", 500);
  }
}
