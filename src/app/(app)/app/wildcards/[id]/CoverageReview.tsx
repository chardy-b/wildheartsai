"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { WildcardFile } from "@/lib/wildcards";
import { coveragePercent } from "@/lib/extraction/presentation";
import { useCoverage } from "../useCoverage";
import { FileViewer } from "./FileViewer";

export function CoverageReview({ file }: { file: WildcardFile }) {
  const [refresh, setRefresh] = useState(0), [page, setPage] = useState(1);
  const [showUncovered, setShowUncovered] = useState(true);
  const [selected, setSelected] = useState("");
  const { entries, loading, error } = useCoverage([file.id], String(refresh), true);
  const coverage = entries[0]?.coverage;
  const targets = useMemo(() => coverage?.pages?.flatMap(p => p.uncovered.map((box, index) => ({ page: p.page, box, key: `${p.page}:${index}` }))) ?? [], [coverage]);
  const index = targets.findIndex(target => target.key === selected && target.page === page);
  const nextIndex = index >= 0 ? index + 1 : targets.findIndex(target => target.page >= page);
  const previousIndex = index >= 0 ? index - 1 : targets.findLastIndex(target => target.page < page);
  const current = coverage?.pages?.find(p => p.page === page);
  const pageTargets = targets.filter(target => target.page === page);
  function jump(next: number) {
    const target = targets[next];
    if (!target) return;
    setPage(target.page); setSelected(target.key); setShowUncovered(true);
  }
  return <section id="coverage-review" className="document-coverage-review" aria-label="Document coverage review">
    <h2>Review uncovered content</h2>
    <p>Red outlines mark non-white content outside the combined text and identified image regions. Review the original to see what was missed.</p>
    {loading && <p role="status">Loading combined coverage…</p>}
    {error && <p role="alert">Coverage could not be loaded. Try refreshing coverage.</p>}
    {coverage && <>
      <dl className="document-report-facts">
        <div><dt>Combined text coverage</dt><dd>{coveragePercent(coverage.textCoverage)}</dd></div>
        <div><dt>Text or image coverage</dt><dd>{coveragePercent(coverage.identifiedCoverage)}</dd></div>
        <div><dt>Unidentified content</dt><dd>{coveragePercent(coverage.unclassifiedCoverage)}</dd></div>
      </dl>
      <p>{coverage.measuredPages} of {coverage.totalPages} pages measured · {coverage.methods.length ? coverage.methods.join(" + ") : "No completed methods"}</p>
      {coverage.measuredPages < coverage.totalPages && <p>Some runs predate combined coverage measurements or use incompatible page renders. <Link href={`/app/wildcards/workbench?fileId=${file.id}`}>Reprocess this document</Link> to measure all pages.</p>}
      {coverage.totalPages === 0 && <p>Process this document in the <Link href={`/app/wildcards/workbench?fileId=${file.id}`}>extraction workbench</Link> to measure coverage.</p>}
      {coverage.totalPages > 0 && coverage.blankPages === coverage.totalPages && <p>No non-white content was detected on the sampled pages.</p>}
    </>}
    <div className="coverage-controls">
      <label><input type="checkbox" checked={showUncovered} onChange={e => setShowUncovered(e.target.checked)} /> Highlight uncovered content</label>
      <button type="button" disabled={previousIndex < 0} onClick={() => jump(previousIndex)}>Previous uncovered area</button>
      <button type="button" disabled={nextIndex < 0 || nextIndex >= targets.length} onClick={() => jump(nextIndex)}>Next uncovered area</button>
      <span role="status">{targets.length ? index < 0 ? `${targets.length} uncovered areas` : `Area ${index + 1} of ${targets.length} · page ${targets[index].page}` : loading ? "Measuring…" : coverage?.measuredPages === coverage?.totalPages && !!coverage?.totalPages ? "No uncovered areas" : "Uncovered areas not measured"}</span>
      <button type="button" disabled={loading} onClick={() => { setSelected(""); setRefresh(n => n + 1); }}>Refresh coverage</button>
    </div>
    {current && <p>Page {page}: {current.status === "measured" ? current.foreground ? `${coveragePercent(current.unclassified / current.foreground)} unidentified content` : "No non-white content" : "Coverage not measured"}</p>}
    <FileViewer file={file} pageNumber={page} onPageChange={setPage}
      activeOverlay={showUncovered ? pageTargets.findIndex(target => target.key === selected) : -1}
      overlays={showUncovered ? pageTargets.map(target => ({ box: target.box, label: `Unidentified content on page ${page}`, color: "#dc2626" })) : []} />
  </section>;
}
