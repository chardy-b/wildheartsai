import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { fileMetadata } from "@/lib/wildcards-store";
import { validFileId } from "@/lib/wildcards-http";
import { fileSize } from "@/lib/wildcards";
import { FileViewer } from "./FileViewer";
import { DocumentReport } from "./DocumentReport";
import "../wildcards.css";

export default async function FilePage({ params }: PageProps<"/app/wildcards/[id]">) {
  const session = await requireSession();
  const { id } = await params;
  if (!validFileId(id)) notFound();
  const file = await fileMetadata(db, recordsKey(), session.user.id, id);
  if (!file || file.status !== "ready") notFound();
  return <section className="app-page wildcards">
    <Link href="/app/wildcards">← Your files</Link>
    <h1 className="wildcard-filename">{file.name}</h1>
    {file.relativePath && <p className="wildcard-file-path">{file.relativePath}</p>}
    <p>{file.type.split(";")[0]} · {fileSize(file.sizeBytes)}</p>
    <p><a href={`/api/wildcards/${file.id}?download=1`} download>Download original</a></p>
    <DocumentReport file={file} />
    <details className="document-original"><summary>Original uploaded file — may contain identifiers</summary><p>This is the original file, separate from the extraction report above.</p><FileViewer file={file} /></details>
  </section>;
}
