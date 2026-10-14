"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FILE_ACCEPT, fileSize, MAX_FILE_BYTES, type WildcardFile } from "@/lib/wildcards";
import { uploadDocument } from "@/lib/wildcards-client";

type UploadResult = { name: string; status: string };
export function Wildcards({ files, available }: { files: WildcardFile[]; available: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  async function upload(selected: File[]) {
    if (!available || busyRef.current || !selected.length) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setResults(selected.map((file) => ({ name: file.name, status: "Waiting" })));
    const update = (index: number, status: string) => setResults((rows) => rows.map((row, i) => i === index ? { ...row, status } : row));
    try {
      for (const [index, file] of selected.entries()) {
        update(index, "Preparing upload…");
        try {
          await uploadDocument(file, (message) => update(index, message));
          update(index, "Uploaded");
        } catch (error) { update(index, `Not uploaded: ${error instanceof Error ? error.message : "Could not complete the upload. Please try again."}`); }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (input.current) input.current.value = "";
      router.refresh();
    }
  }

  async function remove(file: WildcardFile) {
    if (!window.confirm(`Permanently delete “${file.name}”?`)) return;
    setDeleting(file.id);
    setError("");
    try {
      const response = await fetch(`/api/wildcards/${file.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      router.refresh();
    } catch { setError("Could not delete this file. Please try again."); }
    finally { setDeleting(null); }
  }

  return <>
    <div className={`wildcard-drop${dragging ? " is-dragging" : ""}`} aria-busy={busy}
      onDragOver={(event) => { event.preventDefault(); if (available && !busy) setDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(Array.from(event.dataTransfer.files)); }}>
      <h2>{!available ? "Uploads are not available yet" : busy ? "Uploading your files…" : "Drop your files here"}</h2>
      <p>PDF, text, PNG, JPEG, GIF, or WebP · Up to {fileSize(MAX_FILE_BYTES)} per file</p>
      <label className="wildcard-picker">Choose files
        <input ref={input} type="file" multiple accept={FILE_ACCEPT} disabled={busy || !available}
          onChange={(event) => void upload(Array.from(event.target.files ?? []))} />
      </label>
      <p className="wildcard-hint">Select multiple files at once. Files are stored as originals; text extraction and tagging are not available yet.</p>
    </div>
    <div aria-live="polite" aria-atomic="true">
      {results.length > 0 && <ul className="wildcard-results" aria-label="Upload results">
        {results.map((result, index) => <li key={index}><strong>{result.name}</strong><span>{result.status}</span></li>)}
      </ul>}
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="wildcard-list-heading"><h2>Your files <span>({files.length})</span></h2>
      <p>{fileSize(files.reduce((sum, file) => sum + file.sizeBytes, 0))} of 100 MB used · 200 files maximum</p></div>
    {files.length === 0 ? <div className="wildcard-empty"><h3>No files yet</h3><p>Upload a document or image to get started.</p></div> :
      <div className="wildcard-table-wrap"><table className="wildcard-table">
        <caption className="sr-only">Your private files, newest uploads first</caption>
        <thead><tr><th scope="col">File name</th><th scope="col">Type</th><th scope="col">Uploaded</th><th scope="col">Size</th><th scope="col">Actions</th></tr></thead>
        <tbody>{files.map((file) => <tr key={file.id}>
          <th scope="row">{file.status === "ready" ? <a href={`/app/wildcards/${file.id}`}>{file.name}</a> : <>{file.name}<p className="wildcard-hint">{file.status === "deleting" ? "Deletion incomplete. Try Delete again." : "Upload incomplete. Delete and upload again."}</p></>}</th>
          <td>{file.type === "application/pdf" ? "PDF" : file.type.startsWith("text/") ? "Text" : file.type.split("/")[1].toUpperCase()}</td>
          <td><time dateTime={file.uploadedAt}>{file.uploadedAt.slice(0, 16).replace("T", " ")} UTC</time></td>
          <td>{fileSize(file.sizeBytes)}</td>
          <td><div className="wildcard-actions">{file.status === "ready" && <a href={`/api/wildcards/${file.id}?download=1`} download>Download<span className="sr-only"> {file.name}</span></a>}
            <button type="button" disabled={deleting !== null || busy} onClick={() => void remove(file)}>{deleting === file.id ? "Deleting…" : "Delete"}<span className="sr-only"> {file.name}</span></button></div></td>
        </tr>)}</tbody>
      </table></div>}
  </>;
}
