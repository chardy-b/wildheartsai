"use client";

import { Fragment, useState } from "react";
import { fileSize, type WildcardFile } from "@/lib/wildcards";
import { buildFileTree, type FileFolder } from "@/lib/wildcards-paths";
import { statusLabel, type ProgressItem } from "@/lib/extraction/presentation";
import { coveragePercent } from "@/lib/extraction/presentation";
import { useCoverage } from "./useCoverage";

export function FileList({ files, deleting, onDelete, progress }: {
  files: WildcardFile[];
  deleting: string | null;
  onDelete: (file: WildcardFile) => void;
  progress?: ProgressItem[];
}) {
  const [view, setView] = useState<"folders" | "list">("folders");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const latest = new Map(progress?.map(r => [r.fileId, r]));
  const visibleIds = files.filter(f => f.status === "ready" && !f.type.startsWith("text/")).map(f => f.id);
  const version = (progress ?? []).filter(r => visibleIds.includes(r.fileId)).map(r => `${r.id}:${r.status}`).sort().join(",");
  const coverage = useCoverage(visibleIds, version);
  const measurements = new Map(coverage.entries.map(entry => [entry.fileId, entry.coverage]));
  function coverageCell(file: WildcardFile, unidentified: boolean) {
    if (file.type.startsWith("text/")) return "Not applicable";
    if (file.status !== "ready") return "Awaiting upload";
    if (coverage.loading) return "Loading…";
    if (coverage.error) return "Unavailable";
    const value = measurements.get(file.id);
    if (!value?.totalPages) return "Not processed";
    if (value.measuredPages !== value.totalPages) return <a href={`/app/wildcards/${file.id}#coverage-review`}>Reprocess to measure</a>;
    if (value.identifiedCoverage === null) return "No non-white content";
    return <a href={`/app/wildcards/${file.id}#coverage-review`}>
      {coveragePercent(unidentified ? value.unclassifiedCoverage : value.identifiedCoverage)}
      {!unidentified && <small className="wildcard-coverage-detail">Text: {coveragePercent(value.textCoverage)}</small>}
    </a>;
  }
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
        {file.status === "ready" ? <a href={`/app/wildcards/${file.id}`} title={path}>{file.name}</a> : <>{file.name}<p className="wildcard-hint">{file.status === "deleting" ? "Deletion incomplete. Try Delete again." : file.status === "finalizing" ? "Checking and saving your file…" : "Upload incomplete. Reselect this file in the same browser to resume, or delete it."}</p></>}
        {view === "list" && file.relativePath && <p className="wildcard-file-path">{file.relativePath}</p>}
      </div></th>
      <td>{file.status !== "ready" ? "Incomplete" : file.type === "application/pdf" ? "PDF" : file.type.startsWith("text/") ? "Text" : file.type.split("/")[1].toUpperCase()}</td>
      <td><time dateTime={file.uploadedAt}>{file.uploadedAt.slice(0, 16).replace("T", " ")} UTC</time></td>
      <td>{fileSize(file.sizeBytes)}</td>
      <td>{file.status !== "ready" ? "Awaiting upload" : progress ? <a href={`/app/wildcards/${file.id}`}>{statusLabel(latest.get(file.id)?.status ?? "not_started")}</a> : "Loading…"}</td>
      <td>{coverageCell(file, false)}</td><td>{coverageCell(file, true)}</td>
      <td><div className="wildcard-actions">{file.status === "ready" && <><a href={`/app/wildcards/${file.id}/fhir`}>FHIR<span className="sr-only"> view for {path}</span></a><a href={`/api/wildcards/${file.id}?download=1`} download>Download<span className="sr-only"> {path}</span></a></>}
        <button type="button" disabled={deleting !== null} onClick={() => onDelete(file)}>{deleting === file.id ? "Deleting…" : "Delete"}<span className="sr-only"> {path}</span></button></div></td>
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
          <td>{fileSize(child.sizeBytes)}</td><td /><td /><td /><td />
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
    <p className="wildcard-coverage-legend">Combined coverage counts non-white content inside extracted text or identified image regions, across the latest completed methods. Unidentified content is what remains. These are visual estimates.</p>
    <div className="wildcard-table-wrap"><table className="wildcard-table">
      <caption className="sr-only">{view === "folders" ? "Your private files, grouped by folder" : "Your private files, newest uploads first"}</caption>
      <thead><tr><th scope="col">File name</th><th scope="col">Type</th><th scope="col">Uploaded</th><th scope="col">Size</th><th scope="col">Extraction</th><th scope="col">Combined coverage</th><th scope="col">Unidentified content</th><th scope="col">Actions</th></tr></thead>
      <tbody>{view === "folders" ? folderRows(buildFileTree(files)) : files.map((file) => fileRow(file))}</tbody>
    </table></div>
  </>;
}
