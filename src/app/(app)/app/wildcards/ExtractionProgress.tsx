"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { ProgressData } from "@/lib/extraction/presentation";
import { statusLabel } from "@/lib/extraction/presentation";

export function useExtractionProgress() {
  const [data, setData] = useState<ProgressData | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/extraction?overview=1", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error();
        const next = await response.json();
        if (!controller.signal.aborted) { setData(next); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { inFlight = false; }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  return { data, error };
}

export function ExtractionProgress({ data, error }: { data: ProgressData | null; error: boolean }) {
  return <section className="extraction-progress" aria-label="Document processing progress"><h2>Extraction progress</h2>
    <p>Uploading stores the original. Extraction starts when you queue a method in the workbench.</p>
    {error ? <p role="alert">Progress could not be refreshed. Displayed counts may be out of date.</p> : !data ? <p role="status">Loading processing progress…</p> : null}
    {data && <><p>{data.documents} uploaded documents · active run, otherwise latest run per document · refreshes every 10 seconds</p><dl className="extraction-counts">{Object.entries(data.counts).map(([status, count]) => <div key={status}><dt>{statusLabel(status)}</dt><dd>{count}</dd></div>)}</dl></>}
    <p>Completed means the run finished. Open its report to check withheld summaries, warnings, measurements, and coverage.</p>
    <div className="wildcard-actions"><Link href="/app/wildcards/progress">View all document statuses</Link><Link href="/app/wildcards/workbench">Queue or compare extraction methods</Link></div>
  </section>;
}
