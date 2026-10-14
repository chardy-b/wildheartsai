"use client";

import { Fragment, useState } from "react";
import { fileSize, type WildcardFile } from "@/lib/wildcards";
import { buildFileTree, type FileFolder } from "@/lib/wildcards-paths";

export function FileList({ files, busy, deleting, onDelete }: {
  files: WildcardFile[];
  busy: boolean;
  deleting: string | null;
  onDelete: (file: WildcardFile) => void;
}) {
  const [view, setView] = useState<"folders" | "list">("folders");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  function toggle(path: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }
  function fileRow(file: WildcardFile, depth = 0) {
    const path = file.relativePath ?? file.name;
    return <tr key={file.id}>
      <th scope="row"><div style={{ paddingInlineStart: depth * 20 }}>
        {file.status === "ready" ? <a href={`/app/wildcards/${file.id}`} title={path}>{file.name}</a> : <>{file.name}<p className="wildcard-hint">{file.status === "deleting" ? "Deletion incomplete. Try Delete again." : "Upload incomplete. Delete and upload again."}</p></>}
        {view === "list" && file.relativePath && <p className="wildcard-file-path">{file.relativePath}</p>}
      </div></th>
      <td>{file.status !== "ready" ? "Incomplete" : file.type === "application/pdf" ? "PDF" : file.type.startsWith("text/") ? "Text" : file.type.split("/")[1].toUpperCase()}</td>
      <td><time dateTime={file.uploadedAt}>{file.uploadedAt.slice(0, 16).replace("T", " ")} UTC</time></td>
      <td>{fileSize(file.sizeBytes)}</td>
      <td><div className="wildcard-actions">{file.status === "ready" && <a href={`/api/wildcards/${file.id}?download=1`} download>Download<span className="sr-only"> {path}</span></a>}
        <button type="button" disabled={deleting !== null || busy} onClick={() => onDelete(file)}>{deleting === file.id ? "Deleting…" : "Delete"}<span className="sr-only"> {path}</span></button></div></td>
    </tr>;
  }
  function folderRows(folder: FileFolder, depth = 0): React.ReactNode {
    return <>
      {Array.from(folder.folders.values()).sort((a, b) => a.name.localeCompare(b.name)).map((child) => <Fragment key={child.path}>
        <tr className="wildcard-folder-row">
          <th scope="row" colSpan={3}><button type="button" className="wildcard-folder-toggle" style={{ marginInlineStart: depth * 20 }}
            aria-expanded={!collapsed.has(child.path)} aria-label={`${collapsed.has(child.path) ? "Expand" : "Collapse"} folder ${child.path}`}
            onClick={() => toggle(child.path)}>
            <span aria-hidden="true">{collapsed.has(child.path) ? "▸" : "▾"}</span><span>{child.name}/</span>
          </button><span className="wildcard-folder-count">{child.fileCount} {child.fileCount === 1 ? "file" : "files"}</span></th>
          <td>{fileSize(child.sizeBytes)}</td><td />
        </tr>
        {!collapsed.has(child.path) && folderRows(child, depth + 1)}
      </Fragment>)}
      {[...folder.files].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((file) => fileRow(file, depth))}
    </>;
  }
  return <>
    <div className="wildcard-view-options" role="group" aria-label="File view">
      <button type="button" aria-pressed={view === "folders"} onClick={() => setView("folders")}>Folder view</button>
      <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List view</button>
    </div>
    <div className="wildcard-table-wrap"><table className="wildcard-table">
      <caption className="sr-only">{view === "folders" ? "Your private files, grouped by folder" : "Your private files, newest uploads first"}</caption>
      <thead><tr><th scope="col">File name</th><th scope="col">Type</th><th scope="col">Uploaded</th><th scope="col">Size</th><th scope="col">Actions</th></tr></thead>
      <tbody>{view === "folders" ? folderRows(buildFileTree(files)) : files.map((file) => fileRow(file))}</tbody>
    </table></div>
  </>;
}
