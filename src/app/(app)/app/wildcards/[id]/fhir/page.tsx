import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { appUrl } from "@/lib/env";
import { validFileId } from "@/lib/wildcards-http";
import { DocumentFhirError, loadDocumentFhir } from "@/lib/extraction/fhir-store";
import { warningLabel } from "@/lib/extraction/presentation";
import { FhirJson } from "./FhirJson";
import "../../wildcards.css";

export default async function DocumentFhirPage({ params, searchParams }: PageProps<"/app/wildcards/[id]/fhir">) {
  const session = await requireSession();
  const { id } = await params;
  const query = await searchParams;
  const runId = query.runId;
  if (!validFileId(id) || (runId !== undefined && (typeof runId !== "string" || !validFileId(runId)))) notFound();
  let data;
  try { data = await loadDocumentFhir(db, recordsKey(), session.user.id, id, appUrl(), runId); }
  catch (error) {
    if (!(error instanceof DocumentFhirError)) throw error;
    return <section className="app-page wildcards"><Link href={`/app/wildcards/${id}`}>← Document</Link><h1>FHIR view unavailable</h1><p role="alert">{error.message}</p></section>;
  }
  if (!data) notFound();
  const { file, preview, runs, selectedRunId, method } = data;
  const selectedRun = runs.find(r => r.id === selectedRunId);
  const api = `/api/wildcards/${id}/fhir${selectedRunId ? `?runId=${selectedRunId}` : ""}`;
  const download = `${api}${selectedRunId ? "&" : "?"}download=1`;
  return <section className="app-page wildcards document-fhir">
    <Link href={`/app/wildcards/${id}`}>← Back to document</Link>
    <p className="fhir-eyebrow">FHIR R4 · Medplum data view</p>
    <h1 className="wildcard-filename">{file.name}</h1>
    <p>The document and its extracted measurements, represented as FHIR resources.</p>
    <div className="fhir-actions"><a href={download} download className="fhir-download">Download FHIR JSON</a><a href={`/app/wildcards/${id}#document-original`}>View original</a><a href={api}>Open raw JSON</a></div>
    <section className="document-review-notes" aria-label="Review status"><h2>Draft · needs review</h2>
      <p>These results have not been verified against the original. No patient has been assigned. A Medplum import needs a confirmed patient and review of dates, units and clinical codes.</p>
      <p>This view does not send information to Medplum or add results to your health record.</p>
    </section>
    {runs.length > 0 && <form method="get" className="fhir-run-picker"><label htmlFor="fhir-run">Extraction version</label>
      <select id="fhir-run" name="runId" defaultValue={selectedRunId ?? ""}>
        {selectedRunId && !selectedRun && <option value={selectedRunId}>Selected older extraction</option>}
        {runs.map(r => <option key={r.id} value={r.id}>{r.method} · {new Date(r.createdAt).toISOString().replace("T", " ").slice(0, 16)} UTC</option>)}
      </select><button type="submit">View version</button>
    </form>}
    <dl className="document-report-facts fhir-facts"><div><dt>Document resource</dt><dd>DocumentReference</dd></div>
      <div><dt>Extracted results</dt><dd>{preview.measurements.length} Observations</dd></div>
      <div><dt>Extraction</dt><dd>{method ?? "Not yet available"}</dd></div>
      <div><dt>Patient</dt><dd>Unassigned</dd></div></dl>
    {preview.summary && <section><h2>Machine summary</h2><p className="fhir-summary">{preview.summary}</p><p className="document-report-note">Included as a separate DocumentReference linked to the original. This summary is unreviewed.</p></section>}
    <section><h2>Clinical measurements</h2>
      {preview.measurements.length === 0 ? <div className="wildcard-empty"><p>{selectedRunId ? "This extraction did not save measurement candidates. The document may still contain clinical results." : "No completed extraction is available yet. The FHIR view includes the original document reference."}</p>
        <Link href={`/app/wildcards/workbench?fileId=${id}`}>Extract or compare this document</Link></div> :
        <div className="fhir-measurements">{preview.measurements.map(({ resource, source, issues }) => <article key={resource.id}>
          <div className="fhir-result-heading"><h3>{source.name}</h3><span className="fhir-resource-tag">Observation · unreviewed</span></div>
          <p className="fhir-result-value">{source.value} <span>{source.unit || "Unit not stated"}</span></p>
          <dl><div><dt>Source date</dt><dd>{source.date || "Not stated"}</dd></div><div><dt>Reference range</dt><dd>{source.range || "Not stated"}</dd></div><div><dt>Source</dt><dd><a href={`/api/wildcards/${id}#page=${source.page}`}>Original · page {source.page}</a></dd></div></dl>
          {issues.length > 0 && <ul className="fhir-issues">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
          <details><summary>Source quotation</summary><blockquote>{source.evidence}</blockquote></details>
        </article>)}</div>}
    </section>
    <section><h2>Mapping notes</h2><ul>{preview.warnings.map((warning, i) => <li key={i}>{warning.startsWith("Extraction: ") ? warningLabel(warning.slice(12)) : warning}</li>)}</ul>
      <p>Source labels and units are preserved. Ambiguous dates stay in source notes. The PDF is linked to your signed-in account and is not embedded in the download.</p>
      <p>Mapper {preview.mapperVersion}. Resources are checked against the supported R4 structure and internal references; target Medplum profiles need separate validation.</p>
    </section>
    <FhirJson key={selectedRunId ?? file.id} bundle={preview.bundle} />
  </section>;
}
