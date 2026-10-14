"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { FILE_ACCEPT, fileSize, MAX_FILE_BYTES, MAX_FILES, MAX_STORAGE_BYTES, type WildcardFile } from "@/lib/wildcards";
import { DocumentQueue } from "@/lib/documents-queue";
import { filesFromDrop, selectedFiles, type SelectedFile } from "@/lib/wildcards-client";
import { FileList } from "./FileList";

export function Wildcards({ files, available, usage, owner, page }: { files: WildcardFile[]; available: boolean; usage: { count: number; bytes: number }; owner: string; page: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [queue] = useState(() => new DocumentQueue(() => router.refresh(), owner));
  useSyncExternalStore(queue.subscribe, queue.snapshot, queue.snapshot);
  const [reading, setReading] = useState(0);
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
  async function upload(selection: SelectedFile[] | Promise<SelectedFile[]>) {
    if (!available) return;
    setError(""); setReading((count) => count + 1);
    try {
      const selected = await selection;
      if (!selected.length) { setError("No files were found. Empty folders are not uploaded."); return; }
      queue.add(selected);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not read this folder. Use Choose folder or try a smaller folder."); }
    finally {
      setReading((count) => count - 1);
      if (input.current) input.current.value = "";
      if (folderInput.current) folderInput.current.value = "";
    }
  }
  async function remove(file: WildcardFile) {
    if (!window.confirm(`Permanently delete “${file.relativePath ?? file.name}”?`)) return;
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
      onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(filesFromDrop(event.dataTransfer)); }}>
      <h2>{!available ? "Uploads are not available yet" : queue.running ? "Uploading your files…" : "Drop files or folders here"}</h2>
      <p>PDF, text, PNG, JPEG, GIF, or WebP · Up to {fileSize(MAX_FILE_BYTES)} per file</p>
      <div className="wildcard-pickers"><label className="wildcard-picker">Choose files<input ref={input} type="file" multiple accept={FILE_ACCEPT} disabled={!available}
        onChange={(event) => { if (event.target.files?.length) void upload(selectedFiles(event.target.files)); }} /></label>
      <label className="wildcard-picker">Choose folder<input ref={folderInput} type="file" multiple {...{ webkitdirectory: "" }} disabled={!available}
        onChange={(event) => { if (event.target.files?.length) void upload(selectedFiles(event.target.files)); }} /></label></div>
      <p className="wildcard-hint">Folder uploads keep their paths. Add more files while uploading. Keep this page open; if interrupted, reselect the same files in this browser to continue incomplete uploads. Files are stored as originals.</p>
    </div>
    {reading > 0 && <p role="status">Reading selected files and folders…</p>}
    {queue.items.length > 0 && <section aria-label="Upload queue">
      <p role="status">{queue.done - queue.skipped} uploaded · {queue.skipped} skipped · {queue.failed} failed · {remaining} remaining{queue.paused ? " · Paused" : ""}</p>
      {queue.active && <p>Current file: <strong>{queue.active.relativePath ?? queue.active.file.name}</strong> · {queue.active.message}</p>}
      {queue.notice && <p role="alert">{queue.notice}</p>}
      <div className="wildcard-actions">
        {queue.running ? <button type="button" onClick={() => queue.pause()}>Pause uploads</button> : remaining > 0 && <button type="button" onClick={() => queue.resume()}>Resume uploads</button>}
        {!queue.running && queue.failed > 0 && <button type="button" onClick={() => queue.retry()}>Retry failed files</button>}
      </div>
      <ul className="wildcard-results" aria-label="Upload results">
        {queue.items.slice(resultPage * 50, (resultPage + 1) * 50).map((item) => <li key={item.id}><strong>{item.relativePath ?? item.file.name}</strong><span>{item.message}</span></li>)}
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
    {usage.count > 50 && <p className="wildcard-hint">Showing files {((page - 1) * 50) + 1}–{Math.min(page * 50, usage.count)} of {usage.count}. Folder groups and counts apply to this page.</p>}
    {files.length === 0 ? <div className="wildcard-empty"><h3>No files yet</h3><p>Upload a document or image to get started.</p></div> :
      <FileList files={files} deleting={deleting} onDelete={(file) => void remove(file)} />}
    {usage.count > 50 && <nav className="wildcard-actions" aria-label="Document pages">
      {page > 1 && <a href={`/app/wildcards?page=${page - 1}`}>Previous files</a>}
      <form action="/app/wildcards" method="get"><label>Page <input name="page" type="number" min="1" max={Math.ceil(usage.count / 50)} defaultValue={page} key={page} aria-label="Document page" required /></label><span> of {Math.ceil(usage.count / 50)} </span><button type="submit">Go</button></form>
      {page * 50 < usage.count && <a href={`/app/wildcards?page=${page + 1}`}>Next files</a>}
    </nav>}
  </>;
}
