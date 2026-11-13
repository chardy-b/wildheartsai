import { createHash } from "node:crypto";
import { desc, ne, sql } from "drizzle-orm";
import { buildDirectory, EPIC_BRANDS_URL, type DirectoryEntry } from "@/lib/epic/brands";
import { EPIC_ENDPOINTS_URL } from "@/lib/epic/directory";
import { activeGeneration } from "../../data/directory";
import { system } from "../../data/scope";
import type { Db } from "../../db";
import { epicDirectoryEntry, epicDirectoryImport } from "../../db/schema";
import { bundleEntries, trimBrandEntry } from "./stream";

// Importing Epic's directory (src/lib/epic/directory-import.ts and replaceDirectory in the Next
// app), in parts a Workflow can run and retry: download and merge (staged in R2), write the new
// generation in slices, switch searches to it in one statement, then delete the old one. A failure
// anywhere before the switch leaves the stored directory as it was.

// Epic lists about 1,500 organizations. Far fewer means a partial or changed download.
export const MIN_ORGANIZATIONS = 500;
export const ROWS_PER_STEP = 10_000;
const BULK_BYTES = 800_000;
const DELETE_BATCH = 10_000;
// Row ids per generation (Epic lists ~96,000 entries).
const ROW_ID_SPACE = 1_000_000;

export type Downloaded =
  | { changed: false; organizations: number; facilities: number; addresses: number }
  | { changed: true; generation: number; contentHash: string; total: number; organizations: number; facilities: number; addresses: number };

const STAGED_PREFIX = "system/epic-directory/";
const stagedKey = (generation: number) => `${STAGED_PREFIX}${generation}.json`;

export function directoryHash(entries: DirectoryEntry[]): string {
  const hash = createHash("sha256");
  for (const e of entries) hash.update(JSON.stringify([e.kind, e.name, e.fhirBaseUrl, e.partOf, e.location]));
  return hash.digest("hex");
}

async function fetchOk(url: string, fetchImpl: typeof fetch): Promise<Response> {
  const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`${url} responded ${response.status}`);
  return response;
}

// Downloads both lists and merges them. An unchanged list only records the check; a changed one
// is staged in R2 for the write steps.
export async function downloadDirectory(
  db: Db,
  files: R2Bucket,
  { fetchImpl = fetch, now = new Date(), minOrganizations = MIN_ORGANIZATIONS }: { fetchImpl?: typeof fetch; now?: Date; minOrganizations?: number } = {},
): Promise<Downloaded> {
  const [brandsResponse, r4] = await Promise.all([fetchOk(EPIC_BRANDS_URL, fetchImpl), fetchOk(EPIC_ENDPOINTS_URL, fetchImpl).then((r) => r.json())]);
  const trimmed = [];
  for await (const entry of bundleEntries(brandsResponse.body!)) {
    const kept = trimBrandEntry(entry);
    if (kept) trimmed.push(kept);
  }
  const entries = buildDirectory({ resourceType: "Bundle", entry: trimmed }, r4);
  const counts = {
    organizations: entries.filter((e) => e.kind === "organization").length,
    facilities: entries.filter((e) => e.kind === "facility").length,
    addresses: new Set(entries.map((e) => e.fhirBaseUrl)).size,
  };
  if (counts.organizations < minOrganizations) throw new Error(`Epic directory has only ${counts.organizations} organizations; keeping the stored one`);

  const contentHash = directoryHash(entries);
  const [latest] = await system(db).select({ contentHash: epicDirectoryImport.contentHash }).from(epicDirectoryImport).orderBy(desc(epicDirectoryImport.importedAt)).limit(1);
  if (latest?.contentHash === contentHash) {
    await system(db).insert(epicDirectoryImport).values({ importedAt: now, contentHash, changed: false, ...counts });
    return { changed: false, ...counts };
  }
  // Seconds, and above every generation already written (abandoned ones included), so it's unique
  // and ids stay exact integers (generation × 1,000,000 < 2^53).
  const [{ highest }] = await system(db).select({ highest: sql<number | null>`max(${epicDirectoryEntry.generation})` }).from(epicDirectoryEntry);
  const generation = Math.max(Math.floor(now.getTime() / 1000), (highest ?? 0) + 1);
  await files.put(stagedKey(generation), JSON.stringify(entries));
  return { changed: true, generation, contentHash, total: entries.length, ...counts };
}

// Writes one slice of the staged directory as rows of the new generation. Safe to repeat: row ids
// are generation × 1,000,000 + position, so a repeated slice skips the rows it already wrote.
// (`where true`: SQLite needs a WHERE in INSERT … SELECT before ON CONFLICT.)
export async function writeSlice(db: Db, files: R2Bucket, generation: number, slice: number): Promise<number> {
  const staged = await files.get(stagedKey(generation));
  if (!staged) throw new Error("Staged directory is missing");
  const all = (await staged.json()) as DirectoryEntry[];
  if (all.length >= ROW_ID_SPACE) throw new Error("Directory too large for its row ids");
  const first = slice * ROWS_PER_STEP;
  const entries = all.slice(first, first + ROWS_PER_STEP);
  const client = system(db).$client;
  const insert = client.prepare(
    `insert into epic_directory_entry (id, kind, name, fhir_base_url, part_of, location, search_text, generation)
     select json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
       json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), ?1
     from json_each(?2) where true
     on conflict (id) do nothing`,
  );
  const statements: D1PreparedStatement[] = [];
  let chunk: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (chunk.length) statements.push(insert.bind(generation, `[${chunk.join(",")}]`));
    chunk = [];
    bytes = 0;
  };
  entries.forEach((e, i) => {
    const json = JSON.stringify([generation * ROW_ID_SPACE + first + i, e.kind, e.name, e.fhirBaseUrl, e.partOf, e.location, e.searchText]);
    if (chunk.length && bytes + json.length > BULK_BYTES) flush();
    chunk.push(json);
    bytes += json.length;
  });
  flush();
  if (statements.length) await client.batch(statements);
  return entries.length;
}

// Switches searches to the new generation: one statement.
export async function activate(db: Db, download: Extract<Downloaded, { changed: true }>, now: Date): Promise<void> {
  const { generation, contentHash, organizations, facilities, addresses } = download;
  await system(db).insert(epicDirectoryImport).values({ importedAt: now, contentHash, changed: true, organizations, facilities, addresses, generation });
}

// Deletes every generation but the active one (the replaced directory, and any abandoned import),
// in bounded statements, and every staged file (abandoned imports' too).
export async function cleanUp(db: Db, files: R2Bucket): Promise<void> {
  for (;;) {
    const result = await system(db)
      .delete(epicDirectoryEntry)
      .where(sql`rowid in (select rowid from ${epicDirectoryEntry} where ${ne(epicDirectoryEntry.generation, activeGeneration)} limit ${DELETE_BATCH})`)
      .returning({ id: epicDirectoryEntry.id });
    if (result.length < DELETE_BATCH) break;
  }
  for (;;) {
    const staged = await files.list({ prefix: STAGED_PREFIX });
    if (staged.objects.length) await files.delete(staged.objects.map((o) => o.key));
    if (!staged.truncated) break;
  }
}
