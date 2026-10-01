import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { epicDirectoryEntry, epicDirectoryImport } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { DirectoryEntry } from "./brands";
import {
  EPIC_SANDBOX,
  findOrganization,
  isSampleData,
  loadConnectable,
  loadDirectory,
  normalize,
  organizationChoices,
  wordsOf,
  type Organization,
} from "./directory";

const INSERT_BATCH = 1000;
const MAX_QUERY_WORDS = 8;

// Words people add that rarely decide which system they mean. When every word has to match and
// nothing does ("NYU Langone Health" is listed as "NYU Langone Medical Center"), search again
// without these.
const GENERIC_WORDS = new Set([
  "and", "at", "care", "center", "centers", "centre", "clinic", "clinics", "group", "health", "healthcare",
  "hospital", "hospitals", "inc", "medical", "medicine", "network", "of", "physicians", "services", "system",
  "systems", "the",
]);

export type DirectoryImportResult = { changed: boolean; organizations: number; facilities: number; addresses: number };

export function directoryHash(entries: DirectoryEntry[]): string {
  const hash = createHash("sha256");
  for (const e of entries) hash.update(JSON.stringify([e.kind, e.name, e.fhirBaseUrl, e.partOf, e.location]));
  return hash.digest("hex");
}

// Replaces the whole directory in one transaction, so searches see either the old list or the
// new one. An unchanged list only records the check.
export async function replaceDirectory(db: Db, entries: DirectoryEntry[], now: Date): Promise<DirectoryImportResult> {
  const contentHash = directoryHash(entries);
  const result = {
    organizations: entries.filter((e) => e.kind === "organization").length,
    facilities: entries.filter((e) => e.kind === "facility").length,
    addresses: new Set(entries.map((e) => e.fhirBaseUrl)).size,
  };
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ contentHash: epicDirectoryImport.contentHash })
      .from(epicDirectoryImport)
      .orderBy(desc(epicDirectoryImport.importedAt))
      .limit(1);
    const changed = latest?.contentHash !== contentHash;
    if (changed) {
      await tx.delete(epicDirectoryEntry);
      for (let i = 0; i < entries.length; i += INSERT_BATCH) {
        await tx.insert(epicDirectoryEntry).values(entries.slice(i, i + INSERT_BATCH));
      }
    }
    await tx.insert(epicDirectoryImport).values({ importedAt: now, contentHash, changed, ...result });
    return { changed, ...result };
  });
}

export async function directoryLoaded(db: Db): Promise<boolean> {
  const rows = await db.select({ id: epicDirectoryImport.id }).from(epicDirectoryImport).limit(1);
  return rows.length > 0;
}

function matchesAll(words: string[], target: SQL): SQL | undefined {
  return and(...words.map((word) => sql`${target} like ${`% ${word}%`}`));
}

async function searchWords(db: Db, words: string[], exclude: string[], limit: number): Promise<Organization[]> {
  const t = epicDirectoryEntry;
  // The part of search_text before " | " holds the name's own words.
  const nameRank = sql<number>`case when ${matchesAll(words, sql`split_part(${t.searchText}, ' | ', 1)`)} then 0 else 1 end`;
  const kindRank = sql<number>`case when ${t.kind} = 'organization' then 0 else 1 end`;
  const length = sql<number>`length(${t.name})`;
  // The best match per address: each result is one thing to connect to.
  const best = db
    .selectDistinctOn([t.fhirBaseUrl], {
      name: t.name,
      fhirBaseUrl: t.fhirBaseUrl,
      kind: t.kind,
      partOf: t.partOf,
      location: t.location,
      nameRank: nameRank.as("name_rank"),
      kindRank: kindRank.as("kind_rank"),
      length: length.as("name_length"),
    })
    .from(t)
    .where(and(matchesAll(words, sql`${t.searchText}`), exclude.length ? notInArray(t.fhirBaseUrl, exclude) : undefined))
    .orderBy(t.fhirBaseUrl, nameRank, kindRank, length, t.name)
    .as("best");
  const rows = await db
    .select()
    .from(best)
    .orderBy(asc(best.nameRank), asc(best.kindRank), asc(best.length), asc(best.name))
    .limit(limit);
  if (!rows.length) return [];

  // Other names each address is listed under ("Columbia Physicians" is also New York-Presbyterian).
  const names = await db
    .select({ name: t.name, fhirBaseUrl: t.fhirBaseUrl })
    .from(t)
    .where(and(eq(t.kind, "organization"), inArray(t.fhirBaseUrl, rows.map((r) => r.fhirBaseUrl))))
    .orderBy(asc(sql`length(${t.name})`), asc(t.name));
  return rows.map((row) => {
    if (row.kind === "facility" && row.partOf) {
      // A clinic is shown under its own health system; other systems sharing the address would only confuse.
      return { name: row.name, fhirBaseUrl: row.fhirBaseUrl, partOf: row.partOf, ...(row.location ? { location: row.location } : {}) };
    }
    // Skip spellings of the same name ("New York Presbyterian", "New York-Presbyterian").
    const seen = new Set([wordsOf(row.name).join(" ")]);
    const others = names
      .filter((n) => n.fhirBaseUrl === row.fhirBaseUrl)
      .map((n) => n.name)
      .filter((name) => {
        const key = wordsOf(name).join(" ");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3);
    return {
      name: row.name,
      fhirBaseUrl: row.fhirBaseUrl,
      ...(row.location ? { location: row.location } : {}),
      ...(others.length ? { otherNames: others } : {}),
    };
  });
}

// Every query word must start a word of the name, its health system, city or state. Each
// address appears once, as its best-matching name: health systems before their clinics, names
// matching on their own before those matching through their system or city, then shorter first.
export async function searchDirectory(
  db: Db,
  query: string,
  { exclude = [], limit = 20 }: { exclude?: string[]; limit?: number } = {},
): Promise<Organization[]> {
  const words = [...new Set(wordsOf(query))].slice(0, MAX_QUERY_WORDS);
  if (!words.length) return [];
  const results = await searchWords(db, words, exclude, limit);
  const specific = words.filter((word) => !GENERIC_WORDS.has(word));
  if (results.length || !specific.length || specific.length === words.length) return results;
  return searchWords(db, specific, exclude, limit);
}

// The health system at a directory address, named as the person chose it when that name is
// listed there (a facility connects under its system's name).
export async function findDirectoryOrganization(db: Db, fhirBaseUrl: string, name?: string): Promise<Organization | undefined> {
  const wanted = normalize(fhirBaseUrl);
  const rows = await db
    .select({ name: epicDirectoryEntry.name })
    .from(epicDirectoryEntry)
    .where(and(eq(epicDirectoryEntry.kind, "organization"), eq(epicDirectoryEntry.fhirBaseUrl, wanted)))
    .orderBy(asc(sql`length(${epicDirectoryEntry.name})`), asc(epicDirectoryEntry.name));
  if (!rows.length) return undefined;
  const chosen = rows.find((row) => row.name === name) ?? rows[0];
  return { name: chosen.name, fhirBaseUrl: wanted };
}

// What the connect screens offer. In production, once the directory has been imported, search
// it; until then (and in sandbox mode) search Epic's R4 list as before (directory.ts).
export async function connectChoices(
  db: Db,
  environment: "sandbox" | "production",
  query: string,
  connectedUrls: Set<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ results: Organization[]; sample: Organization | null }> {
  if (environment === "production" && (await directoryLoaded(db))) {
    return {
      results: query.trim() ? await searchDirectory(db, query, { exclude: [...connectedUrls] }) : [],
      sample: connectedUrls.has(EPIC_SANDBOX.fhirBaseUrl) ? null : EPIC_SANDBOX,
    };
  }
  return organizationChoices(environment, await loadConnectable(environment, fetchImpl), connectedUrls, query);
}

// The organization a connection may start with: the sandbox, a directory address, or any
// address on Epic's R4 list (which existing connections, and their Reconnect links, came from).
export async function findConnectable(
  db: Db,
  environment: "sandbox" | "production",
  fhirBaseUrl: string,
  name?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Organization | undefined> {
  if (isSampleData({ fhirBaseUrl })) return EPIC_SANDBOX;
  if (environment === "sandbox") return undefined;
  return (
    (await findDirectoryOrganization(db, fhirBaseUrl, name)) ??
    findOrganization(await loadDirectory("production", fetchImpl), fhirBaseUrl)
  );
}
