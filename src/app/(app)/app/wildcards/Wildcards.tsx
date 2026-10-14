"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FILE_ACCEPT, fileSize, MAX_FILE_BYTES, type WildcardFile } from "@/lib/wildcards";
import { filesFromDrop, selectedFiles, uploadDocument, type SelectedFile } from "@/lib/wildcards-client";
import { FileList } from "./FileList";

type UploadResult = { name: string; status: string };
export function Wildcards({ files, available }: { files: WildcardFile[]; available: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  async function upload(selection: SelectedFile[] | Promise<SelectedFile[]>) {
    if (!available || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setResults([]);
    const update = (index: number, status: string) => setResults((rows) => rows.map((row, i) => i === index ? { ...row, status } : row));
    try {
      const selected = await selection;
      if (!selected.length) { setError("No files were found. Empty folders are not uploaded."); return; }
      setResults(selected.map(({ file, relativePath }) => ({ name: relativePath ?? file.name, status: "Waiting" })));
      for (const [index, { file, relativePath }] of selected.entries()) {
        update(index, "Preparing upload…");
        try {
          await uploadDocument(file, (message) => update(index, message), relativePath);
          update(index, "Uploaded");
        } catch (error) { update(index, `Not uploaded: ${error instanceof Error ? error.message : "Could not complete the upload. Please try again."}`); }
      }
    } catch (error) { setError(error instanceof Error ? error.message : "Could not read the selected folder. Use Choose folder or try a smaller folder."); }
    finally {
      busyRef.current = false;
      setBusy(false);
      if (input.current) input.current.value = "";
      if (folderInput.current) folderInput.current.value = "";
      router.refresh();
    }
  }

  async function remove(file: WildcardFile) {
    if (!window.confirm(`Permanently delete “${file.relativePath ?? file.name}”?`)) return;
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
      onDrop={(event) => { event.preventDefault(); setDragging(false); if (available && !busyRef.current) void upload(filesFromDrop(event.dataTransfer)); }}>
      <h2>{!available ? "Uploads are not available yet" : busy ? "Uploading your files…" : "Drop files or folders here"}</h2>
      <p>PDF, text, PNG, JPEG, GIF, or WebP · Up to {fileSize(MAX_FILE_BYTES)} per file</p>
      <div className="wildcard-pickers"><label className="wildcard-picker">Choose files
        <input ref={input} type="file" multiple accept={FILE_ACCEPT} disabled={busy || !available}
          onChange={(event) => { if (event.target.files?.length) void upload(selectedFiles(event.target.files)); }} />
      </label>
      <label className="wildcard-picker">Choose folder
        <input ref={folderInput} type="file" multiple {...{ webkitdirectory: "" }} disabled={busy || !available}
          onChange={(event) => { if (event.target.files?.length) void upload(selectedFiles(event.target.files)); }} />
      </label></div>
      <p className="wildcard-hint">Folder uploads keep the selected folder and its subfolders. Unsupported files are not uploaded; empty folders are not kept. Files are stored as originals; parsing and indexing are not available yet.</p>
    </div>
    <div aria-live="polite" aria-atomic="true">
      {results.length > 0 && <ul className="wildcard-results" aria-label="Upload results">
        {results.map((result, index) => <li key={index}><strong>{result.name}</strong><span>{result.status}</span></li>)}
      </ul>}
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="wildcard-list-heading"><h2>Your files <span>({files.length})</span></h2>
      <p>{fileSize(files.reduce((sum, file) => sum + file.sizeBytes, 0))} of 100 MB used · 200 files maximum</p></div>
    {files.length === 0 ? <div className="wildcard-empty"><h3>No files yet</h3><p>Upload files or a folder to get started.</p></div> :
      <FileList files={files} busy={busy} deleting={deleting} onDelete={(file) => void remove(file)} />}
  </>;
}
