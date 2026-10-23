"use client";

import { useEffect, useState } from "react";
import type { CoveragePage, CoverageSummary } from "@/lib/extraction/coverage";

type Entry = { fileId: string; coverage: CoverageSummary & { pages?: CoveragePage[] } };
export function useCoverage(fileIds: string[], refreshKey: string, details = false) {
  const key = JSON.stringify([fileIds, refreshKey, details]);
  const [response, setResponse] = useState<{ key: string; entries: Entry[]; error: boolean } | null>(null);
  useEffect(() => {
    const [ids, , detailed] = JSON.parse(key) as [string[], string, boolean];
    if (!ids.length) return;
    const controller = new AbortController();
    async function load() {
      try {
        const query = new URLSearchParams({ coverage: "1", ...(detailed ? { details: "1" } : {}) });
        for (const id of ids) query.append("fileId", id);
        const result = await fetch(`/api/extraction?${query}`, { cache: "no-store", signal: controller.signal });
        if (!result.ok) throw new Error();
        const data: { files: Entry[] } = await result.json();
        if (!controller.signal.aborted) setResponse({ key, entries: data.files, error: false });
      } catch {
        if (!controller.signal.aborted) setResponse({ key, entries: [], error: true });
      }
    }
    void load();
    return () => controller.abort();
  }, [key]);
  return { entries: response?.key === key ? response.entries : [], error: response?.key === key && response.error,
    loading: fileIds.length > 0 && response?.key !== key };
}
