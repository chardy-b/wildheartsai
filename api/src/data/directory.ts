import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
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
} from "@/lib/epic/directory";
import type { Db } from "../db";
import { epicDirectoryEntry, epicDirectoryImport } from "../db/schema";

// Searching Epic's directory of health systems and clinics (src/lib/epic/directory-store.ts in
// the Next app). Public reference data: no user_id, read with the system handle. The import
// (Phase 4) writes it; until the first import, search uses Epic's R4 list live, as before.

const MAX_QUERY_WORDS = 8;

// Epic's R4 list, cached at Cloudflare's edge for a day (what `next: { revalidate }` did on Vercel).
const cachedFetch: typeof fetch = (input, init) => fetch(input, { ...init, cf: { cacheTtl: 60 * 60 * 24, cacheEverything: true } });

// Words people add that rarely decide which system they mean. When every word has to match and
// nothing does, search again without these.
const GENERIC_WORDS = new Set([
  "and", "at", "care", "center", "centers", "centre", "clinic", "clinics", "group", "health", "healthcare",
  "hospital", "hospitals", "inc", "medical", "medicine", "network", "of", "physicians", "services", "system",
  "systems", "the",
]);

// The generation searches read: the one the latest changed import activated, or 0 (rows copied
// from Neon, or none) before any import here.
export const activeGeneration = sql`coalesce((select ${epicDirectoryImport.generation} from ${epicDirectoryImport} where ${epicDirectoryImport.generation} is not null order by ${epicDirectoryImport.importedAt} desc limit 1), 0)`;

export async function directoryLoaded(db: Db): Promise<boolean> {
  const rows = await db.select({ id: epicDirectoryImport.id }).from(epicDirectoryImport).limit(1);
  return rows.length > 0;
}

function matchesAll(words: string[], target: SQL): SQL {
  return sql.join(words.map((word) => sql`${target} like ${`% ${word}%`}`), sql` and `);
}

type Row = { name: string; fhir_base_url: string; kind: string; part_of: string | null; location: string | null };

async function searchWords(db: Db, words: string[], exclude: string[], limit: number): Promise<Organization[]> {
  // The part of search_text before " | " holds the name's own words (Postgres used split_part).
  const nameWords = sql`substr(search_text, 1, instr(search_text || ' | ', ' | ') - 1)`;
  const excluded = exclude.length ? sql` and fhir_base_url not in (${sql.join(exclude.map((url) => sql`${url}`), sql`, `)})` : sql``;
  // The best match per address (Postgres used DISTINCT ON): each result is one thing to connect to.
  const rows = await db.all<Row>(sql`
    select name, fhir_base_url, kind, part_of, location from (
      select name, fhir_base_url, kind, part_of, location, name_rank, kind_rank, name_length,
        row_number() over (partition by fhir_base_url order by name_rank, kind_rank, name_length, name) as best
      from (
        select name, fhir_base_url, kind, part_of, location,
          case when ${matchesAll(words, nameWords)} then 0 else 1 end as name_rank,
          case when kind = 'organization' then 0 else 1 end as kind_rank,
          length(name) as name_length
        from ${epicDirectoryEntry}
        where generation = ${activeGeneration} and ${matchesAll(words, sql`search_text`)}${excluded}
      )
    )
    where best = 1
    order by name_rank, kind_rank, name_length, name
    limit ${limit}`);
  if (!rows.length) return [];

  // Other names each address is listed under ("Columbia Physicians" is also New York-Presbyterian).
  const t = epicDirectoryEntry;
  const names = await db
    .select({ name: t.name, fhirBaseUrl: t.fhirBaseUrl })
    .from(t)
    .where(and(eq(t.generation, activeGeneration), eq(t.kind, "organization"), inArray(t.fhirBaseUrl, rows.map((r) => r.fhir_base_url))))
    .orderBy(asc(sql`length(${t.name})`), asc(t.name));
  return rows.map((row) => {
    if (row.kind === "facility" && row.part_of) {
      // A clinic is shown under its own health system; other systems sharing the address would only confuse.
      return { name: row.name, fhirBaseUrl: row.fhir_base_url, partOf: row.part_of, ...(row.location ? { location: row.location } : {}) };
    }
    // Skip spellings of the same name ("New York Presbyterian", "New York-Presbyterian").
    const seen = new Set([wordsOf(row.name).join(" ")]);
    const others = names
      .filter((n) => n.fhirBaseUrl === row.fhir_base_url)
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
      fhirBaseUrl: row.fhir_base_url,
      ...(row.location ? { location: row.location } : {}),
      ...(others.length ? { otherNames: others } : {}),
    };
  });
}

// Every query word must start a word of the name, its health system, city or state. Each address
// appears once, as its best-matching name: health systems before their clinics, names matching on
// their own before those matching through their system or city, then shorter first.
export async function searchDirectory(db: Db, query: string, { exclude = [], limit = 20 }: { exclude?: string[]; limit?: number } = {}): Promise<Organization[]> {
  const words = [...new Set(wordsOf(query))].slice(0, MAX_QUERY_WORDS);
  if (!words.length) return [];
  const results = await searchWords(db, words, exclude, limit);
  const specific = words.filter((word) => !GENERIC_WORDS.has(word));
  if (results.length || !specific.length || specific.length === words.length) return results;
  return searchWords(db, specific, exclude, limit);
}

// The health system at a directory address, named as the person chose it when that name is listed.
export async function findDirectoryOrganization(db: Db, fhirBaseUrl: string, name?: string): Promise<Organization | undefined> {
  const wanted = normalize(fhirBaseUrl);
  const rows = await db
    .select({ name: epicDirectoryEntry.name })
    .from(epicDirectoryEntry)
    .where(and(eq(epicDirectoryEntry.generation, activeGeneration), eq(epicDirectoryEntry.kind, "organization"), eq(epicDirectoryEntry.fhirBaseUrl, wanted)))
    .orderBy(asc(sql`length(${epicDirectoryEntry.name})`), asc(epicDirectoryEntry.name));
  if (!rows.length) return undefined;
  const chosen = rows.find((row) => row.name === name) ?? rows[0];
  return { name: chosen.name, fhirBaseUrl: wanted };
}

// What the connect screens offer. In production, once the directory has been imported, search it;
// until then (and in sandbox mode) search Epic's R4 list.
export async function connectChoices(
  db: Db,
  environment: "sandbox" | "production",
  query: string,
  connectedUrls: Set<string>,
  fetchImpl: typeof fetch = cachedFetch,
): Promise<{ results: Organization[]; sample: Organization | null }> {
  if (environment === "production" && (await directoryLoaded(db))) {
    return {
      results: query.trim() ? await searchDirectory(db, query, { exclude: [...connectedUrls] }) : [],
      sample: connectedUrls.has(EPIC_SANDBOX.fhirBaseUrl) ? null : EPIC_SANDBOX,
    };
  }
  return organizationChoices(environment, await loadConnectable(environment, fetchImpl), connectedUrls, query);
}

// The organization a connection may start with: the sandbox, a directory address, or any address
// on Epic's R4 list (which existing connections, and their Reconnect links, came from).
export async function findConnectable(
  db: Db,
  environment: "sandbox" | "production",
  fhirBaseUrl: string,
  name?: string,
  fetchImpl: typeof fetch = cachedFetch,
): Promise<Organization | undefined> {
  if (isSampleData({ fhirBaseUrl })) return EPIC_SANDBOX;
  if (environment === "sandbox") return undefined;
  return (await findDirectoryOrganization(db, fhirBaseUrl, name)) ?? findOrganization(await loadDirectory("production", fetchImpl), fhirBaseUrl);
}
