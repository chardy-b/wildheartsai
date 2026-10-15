"use client";
import { useState } from "react";
import type { WildcardFile } from "@/lib/wildcards";
import { statusLabel } from "@/lib/extraction/presentation";
import { ExtractionProgress, useExtractionProgress } from "../ExtractionProgress";

export function Progress({ files }: { files: WildcardFile[] }) {
  const { data, error } = useExtractionProgress();
  const [filter, setFilter] = useState("all"), [search, setSearch] = useState(""), [page, setPage] = useState(0);
  const latest = new Map(data?.files.map(r => [r.fileId, r]));
  const matched = files.filter(f => (filter === "all" || (latest.get(f.id)?.status ?? "not_started") === filter) && (f.relativePath ?? f.name).toLowerCase().includes(search.toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matched.length / 50) - 1));
  return <><ExtractionProgress data={data} error={error} />
    <div className="wildcard-view-options"><label>Processing status <select value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}><option value="all">All documents</option>{Object.keys(data?.counts ?? {}).map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></label>
      <label>Find a document <input type="search" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} /></label></div>
    <p>{matched.length} matching documents{!data ? " · status loading" : ""}</p>
    <div className="wildcard-table-wrap"><table className="wildcard-table"><caption className="sr-only">Processing status of your uploaded documents</caption><thead><tr><th>Document</th><th>Latest status</th><th>Requested method</th><th>Attempts / retry</th><th>Result</th></tr></thead><tbody>
      {matched.slice(currentPage * 50, (currentPage + 1) * 50).map(f => { const r = latest.get(f.id); return <tr key={f.id}><th scope="row"><a href={`/app/wildcards/${f.id}`}>{f.relativePath ?? f.name}</a></th><td>{data ? statusLabel(r?.status ?? "not_started") : "Loading…"}{r?.errorCode && <p>{r.errorCode.replaceAll("_", " ")}</p>}</td><td>{r?.method ?? "—"}</td><td>{r?.attempts ?? "—"}{r?.status === "queued" && r.errorCode && <p>Retry after {new Date(r.nextAttemptAt).toLocaleString()}</p>}</td><td><a href={`/app/wildcards/${f.id}`}>{r?.status === "completed" ? "View report" : "Open document"}</a></td></tr>; })}
    </tbody></table></div><nav className="wildcard-pagination" aria-label="Processing status pages"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {Math.max(1, Math.ceil(matched.length / 50))}</span><button disabled={(currentPage + 1) * 50 >= matched.length} onClick={() => setPage(currentPage + 1)}>Next</button></nav>
  </>;
}
