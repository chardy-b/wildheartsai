import type { Db } from "@/lib/db/types";
import { buildDirectory, EPIC_BRANDS_URL } from "./brands";
import { EPIC_ENDPOINTS_URL } from "./directory";
import { replaceDirectory, type DirectoryImportResult } from "./directory-store";

// Epic lists about 1,500 organizations. Far fewer means a partial or changed download: keep
// the stored directory rather than replace it with a fragment.
export const MIN_ORGANIZATIONS = 500;

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  // no-store: the brands list is ~95 MB, too big for Next's fetch cache, and read once a day anyway.
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

// Downloads Epic's Brands bundle and R4 endpoint list and replaces the stored directory.
export async function importEpicDirectory(
  db: Db,
  { fetchImpl = fetch, now = new Date(), minOrganizations = MIN_ORGANIZATIONS }: { fetchImpl?: typeof fetch; now?: Date; minOrganizations?: number } = {},
): Promise<DirectoryImportResult> {
  const [brands, r4] = await Promise.all([fetchJson(EPIC_BRANDS_URL, fetchImpl), fetchJson(EPIC_ENDPOINTS_URL, fetchImpl)]);
  const entries = buildDirectory(brands, r4);
  const organizations = entries.filter((e) => e.kind === "organization").length;
  if (organizations < minOrganizations) {
    throw new Error(`Epic directory has only ${organizations} organizations; keeping the stored one`);
  }
  return replaceDirectory(db, entries, now);
}
