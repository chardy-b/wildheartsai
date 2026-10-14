"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { FILE_ACCEPT, fileSize, MAX_FILE_BYTES, MAX_FILES, MAX_STORAGE_BYTES, type WildcardFile } from "@/lib/wildcards";
import { DocumentQueue } from "@/lib/documents-queue";

export function Wildcards({ files, available, usage, owner, page }: { files: WildcardFile[]; available: boolean; usage: { count: number; bytes: number }; owner: string; page: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [queue] = useState(() => new DocumentQueue(() => router.refresh(), owner));
  useSyncExternalStore(queue.subscribe, queue.snapshot, queue.snapshot);
  const [dragging, setDragging] = useState(false);
  const [resultPage, setResultPage] = useState(0);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const remaining = queue.items.length - queue.done - queue.failed;
  useEffect(() => {
    queue.attach();
    const warn = (event: BeforeUnloadEvent) => { if (queue.items.some((item) => item.state !== "done")) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); queue.dispose(); };
  }, [queue]);
  function upload(selected: File[]) {
    if (!available || !selected.length) return;
    queue.add(selected);
    if (input.current) input.current.value = "";
  }
  async function remove(file: WildcardFile) {
    if (!window.confirm(`Permanently delete “${file.name}”?`)) return;
    setDeleting(file.id); setError("");
    try {
      const response = await fetch(`/api/wildcards/${file.id}`, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error();
      router.refresh();
    } catch { setError("Could not delete this file. Please try again."); }
    finally { setDeleting(null); }
  }
  return <>
    <div className={`wildcard-drop${dragging ? " is-dragging" : ""}`} aria-busy={queue.running}
      onDragOver={(event) => { event.preventDefault(); if (available) setDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); upload(Array.from(event.dataTransfer.files)); }}>
      <h2>{!available ? "Uploads are not available yet" : queue.running ? "Uploading your files…" : "Drop your files here"}</h2>
      <p>PDF, text, PNG, JPEG, GIF, or WebP · Up to {fileSize(MAX_FILE_BYTES)} per file</p>
      <label className="wildcard-picker">Choose files<input ref={input} type="file" multiple accept={FILE_ACCEPT} disabled={!available}
        onChange={(event) => upload(Array.from(event.target.files ?? []))} /></label>
      <p className="wildcard-hint">Add more files while uploading. Keep this page open; if interrupted, reselect the same files in this tab to continue incomplete uploads. Files are stored as originals.</p>
    </div>
    {queue.items.length > 0 && <section aria-label="Upload queue">
      <p role="status">{queue.done} uploaded · {queue.failed} failed · {remaining} remaining{queue.paused ? " · Paused" : ""}</p>
      {queue.notice && <p role="alert">{queue.notice}</p>}
      <div className="wildcard-actions">
        {queue.running ? <button type="button" onClick={() => queue.pause()}>Pause uploads</button> : remaining > 0 && <button type="button" onClick={() => queue.resume()}>Resume uploads</button>}
        {!queue.running && queue.failed > 0 && <button type="button" onClick={() => queue.retry()}>Retry failed files</button>}
      </div>
      <ul className="wildcard-results" aria-label="Upload results">
        {queue.items.slice(resultPage * 50, (resultPage + 1) * 50).map((item) => <li key={item.id}><strong>{item.file.name}</strong><span>{item.message}</span></li>)}
      </ul>
      {queue.items.length > 50 && <div className="wildcard-actions">
        <button disabled={resultPage === 0} onClick={() => setResultPage((value) => value - 1)}>Previous results</button>
        <span>Results page {resultPage + 1} of {Math.ceil(queue.items.length / 50)}</span>
        <button disabled={(resultPage + 1) * 50 >= queue.items.length} onClick={() => setResultPage((value) => value + 1)}>Next results</button>
      </div>}
    </section>}
    {error && <p role="alert">{error}</p>}
    <div className="wildcard-list-heading"><h2>Your files <span>({usage.count})</span></h2>
      <p>{fileSize(usage.bytes)} of {fileSize(MAX_STORAGE_BYTES)} used · {MAX_FILES.toLocaleString()} files maximum</p></div>
    {files.length === 0 ? <div className="wildcard-empty"><h3>No files yet</h3><p>Upload a document or image to get started.</p></div> :
      <div className="wildcard-table-wrap"><table className="wildcard-table">
        <caption className="sr-only">Your private files, newest uploads first</caption>
        <thead><tr><th scope="col">File name</th><th scope="col">Type</th><th scope="col">Uploaded</th><th scope="col">Size</th><th scope="col">Actions</th></tr></thead>
        <tbody>{files.map((file) => <tr key={file.id}>
          <th scope="row">{file.status === "ready" ? <a href={`/app/wildcards/${file.id}`}>{file.name}</a> : <>{file.name}<p className="wildcard-hint">{file.status === "deleting" ? "Deletion incomplete. Try Delete again." : file.status === "finalizing" ? "Checking and saving your file…" : "Upload incomplete. Reselect this file in the same tab to resume, or delete it."}</p></>}</th>
          <td>{file.type === "application/pdf" ? "PDF" : file.type.startsWith("text/") ? "Text" : file.type === "application/octet-stream" ? "Pending" : file.type.split("/")[1].toUpperCase()}</td>
          <td><time dateTime={file.uploadedAt}>{file.uploadedAt.slice(0, 16).replace("T", " ")} UTC</time></td>
          <td>{fileSize(file.sizeBytes)}</td>
          <td><div className="wildcard-actions">{file.status === "ready" && <a href={`/api/wildcards/${file.id}?download=1`} download>Download<span className="sr-only"> {file.name}</span></a>}
            <button type="button" disabled={deleting !== null} onClick={() => void remove(file)}>{deleting === file.id ? "Deleting…" : "Delete"}<span className="sr-only"> {file.name}</span></button></div></td>
        </tr>)}</tbody>
      </table></div>}
    {usage.count > 50 && <nav className="wildcard-actions" aria-label="Document pages">
      {page > 1 && <a href={`/app/wildcards?page=${page - 1}`}>Previous files</a>}
      <span>Page {page} of {Math.ceil(usage.count / 50)}</span>
      {page * 50 < usage.count && <a href={`/app/wildcards?page=${page + 1}`}>Next files</a>}
    </nav>}
  </>;
}
