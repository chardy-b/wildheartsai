import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { listFiles } from "@/lib/wildcards-store";
import { fileSize } from "@/lib/wildcards";
import { FileViewer } from "./FileViewer";
import "../wildcards.css";

export default async function FilePage({ params }: PageProps<"/app/wildcards/[id]">) {
  const session = await requireSession();
  const { id } = await params;
  const file = (await listFiles(db, recordsKey(), session.user.id)).find((row) => row.id === id && row.status === "ready");
  if (!file) notFound();
  return <section className="app-page wildcards">
    <Link href="/app/wildcards">← Your files</Link>
    <h1 className="wildcard-filename">{file.name}</h1>
    <p>{file.type.split(";")[0]} · {fileSize(file.sizeBytes)}</p>
    <p><a href={`/api/wildcards/${file.id}?download=1`} download>Download original</a></p>
    <FileViewer file={file} />
  </section>;
}
