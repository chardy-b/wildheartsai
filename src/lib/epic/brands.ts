import { normalize, parseEndpoints, safeEndpointBase, wordsOf } from "./directory";

// Epic's "User-access Brands" bundle (open.epic.com → Endpoints → Brands): about 1,300 brands
// (the health system a patient knows), each with one FHIR endpoint, and about 96,000
// facilities (hospitals, clinics, practices) that are `partOf` a brand. It is ~95 MB, so it is
// turned into a compact, searchable table by a daily job (directory-import.ts) and never
// fetched while a person searches.
export const EPIC_BRANDS_URL = "https://open.epic.com/Endpoints/Brands";

export type DirectoryEntry = {
  kind: "organization" | "facility";
  name: string;
  fhirBaseUrl: string;
  // The brand a facility belongs to; null for an organization.
  partOf: string | null;
  // "City, ST" for a facility; the states its facilities are in for an organization.
  location: string | null;
  // Space-separated search words, name first: " name words | context words ".
  searchText: string;
};

type Resource = {
  resourceType?: unknown;
  name?: unknown;
  status?: unknown;
  address?: unknown;
  partOf?: { reference?: unknown };
  endpoint?: { reference?: unknown }[];
};

type Brand = { name: string; fhirBaseUrl: string; states: Map<string, number> };

const MAX_NAME = 200;

function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return name || undefined;
}

function hostOf(url: string): string {
  return new URL(url).host.toLowerCase();
}

function titleCase(text: string): string {
  if (text !== text.toUpperCase()) return text;
  return text.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_match, gap: string, letter: string) => gap + letter.toUpperCase());
}

function placeOf(resource: Resource): { city?: string; state?: string } {
  const [address] = Array.isArray(resource.address) ? (resource.address as { city?: unknown; state?: unknown }[]) : [];
  const city = cleanName(address?.city);
  const state = cleanName(address?.state);
  return { city: city ? titleCase(city) : undefined, state: state?.toUpperCase() };
}

// Up to three states, most facilities first: "NJ, PA" or "CA, NV, HI and 2 more".
function formatStates(counts: Map<string, number> | undefined): string | null {
  if (!counts?.size) return null;
  const states = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([state]) => state);
  const shown = states.slice(0, 3).join(", ");
  return states.length > 3 ? `${shown} and ${states.length - 3} more` : shown;
}

// A name's words plus each adjacent pair joined, so "MinuteClinic" finds "Minute Clinic" and
// "NewYork-Presbyterian" finds "New York-Presbyterian".
function nameWords(name: string): string[] {
  const words = wordsOf(name);
  return [...words, ...words.slice(1).map((word, i) => words[i] + word)];
}

export function searchTextFor(name: string, context: string[]): string {
  return ` ${nameWords(name).join(" ")} | ${context.flatMap(wordsOf).join(" ")} `;
}

function entriesOf(json: unknown): { fullUrl?: unknown; resource?: Resource }[] {
  const bundle = json as { resourceType?: unknown; entry?: unknown };
  if (bundle?.resourceType !== "Bundle" || !Array.isArray(bundle.entry)) throw new Error("Epic brands list isn't a FHIR Bundle");
  return bundle.entry as { fullUrl?: unknown; resource?: Resource }[];
}

// Merges Epic's Brands bundle with its R4 endpoint list into one directory.
//
// The R4 list is what the site used before, and existing connections (and their Reconnect
// links) use its addresses, so R4 wins wherever the two lists describe the same system:
// - the same address in different letter case keeps the R4 spelling;
// - a brand with the same name and host as an R4 entry, but a different path (".../HOME/api/
//   FHIR/R4"), uses the R4 address. Same name on a different host is a different system
//   (two unrelated "Summit Health"s), so it stays separate.
// Every R4 entry stays in the directory, including those Brands doesn't list.
export function buildDirectory(brandsJson: unknown, r4Json: unknown): DirectoryEntry[] {
  const r4 = parseEndpoints(r4Json);
  const r4ByAddress = new Map(r4.map((org) => [org.fhirBaseUrl.toLowerCase(), org.fhirBaseUrl]));
  const r4ByNameAndHost = new Map<string, string>();
  for (const org of r4) {
    for (const name of [org.name, ...(org.otherNames ?? [])]) {
      r4ByNameAndHost.set(`${name.toLowerCase()} ${hostOf(org.fhirBaseUrl)}`, org.fhirBaseUrl);
    }
  }

  const byUrl = new Map<string, Resource>();
  const entries = entriesOf(brandsJson);
  for (const { fullUrl, resource } of entries) {
    if (typeof fullUrl === "string" && resource && typeof resource === "object") byUrl.set(fullUrl, resource);
  }

  const brands = new Map<string, Brand>();
  for (const [url, resource] of byUrl) {
    if (resource.resourceType !== "Organization" || resource.partOf) continue;
    const name = cleanName(resource.name);
    const endpoint = byUrl.get(String(resource.endpoint?.[0]?.reference ?? ""));
    if (!name || endpoint?.resourceType !== "Endpoint" || endpoint.status !== "active") continue;
    const own = typeof endpoint.address === "string" ? safeEndpointBase(endpoint.address) : undefined;
    if (!own) continue;
    const fhirBaseUrl =
      r4ByAddress.get(own.toLowerCase()) ?? r4ByNameAndHost.get(`${name.toLowerCase()} ${hostOf(own)}`) ?? own;
    brands.set(url, { name, fhirBaseUrl, states: new Map() });
  }

  const out = new Map<string, DirectoryEntry>();
  const add = (entry: Omit<DirectoryEntry, "searchText">, context: string[]) => {
    // An organization appears once per name and address; a facility once per place.
    const place = entry.kind === "facility" ? (entry.location ?? "") : "";
    const key = [entry.kind, entry.name.toLowerCase(), entry.fhirBaseUrl, place].join("\n");
    if (!out.has(key)) out.set(key, { ...entry, searchText: searchTextFor(entry.name, context) });
  };

  const statesByAddress = new Map<string, Map<string, number>>();
  for (const resource of byUrl.values()) {
    if (resource.resourceType !== "Organization" || !resource.partOf) continue;
    const brand = brands.get(String(resource.partOf.reference ?? ""));
    const name = cleanName(resource.name);
    if (!brand || !name) continue;
    const { city, state } = placeOf(resource);
    if (state) {
      brand.states.set(state, (brand.states.get(state) ?? 0) + 1);
      const shared = statesByAddress.get(brand.fhirBaseUrl) ?? new Map<string, number>();
      shared.set(state, (shared.get(state) ?? 0) + 1);
      statesByAddress.set(brand.fhirBaseUrl, shared);
    }
    // A facility named exactly like its brand adds nothing to the brand's own entry.
    if (name.toLowerCase() === brand.name.toLowerCase()) continue;
    const location = [city, state].filter(Boolean).join(", ") || null;
    add(
      { kind: "facility", name, fhirBaseUrl: brand.fhirBaseUrl, partOf: brand.name, location },
      [brand.name, city ?? "", state ?? ""],
    );
  }

  for (const brand of brands.values()) {
    add(
      { kind: "organization", name: brand.name, fhirBaseUrl: brand.fhirBaseUrl, partOf: null, location: formatStates(brand.states) },
      [...brand.states.keys()],
    );
  }

  // An R4-only address borrows its states from the brands on its host when they all share one
  // address, as "Summit Health" (R4) does from "Summit Health - Oregon".
  const addressesByHost = new Map<string, Set<string>>();
  for (const brand of brands.values()) {
    const host = hostOf(brand.fhirBaseUrl);
    addressesByHost.set(host, (addressesByHost.get(host) ?? new Set()).add(brand.fhirBaseUrl));
  }
  for (const org of r4) {
    let states = statesByAddress.get(org.fhirBaseUrl);
    const onHost = addressesByHost.get(hostOf(org.fhirBaseUrl));
    if (!states && onHost?.size === 1) states = statesByAddress.get([...onHost][0]);
    for (const name of [org.name, ...(org.otherNames ?? [])]) {
      add(
        { kind: "organization", name, fhirBaseUrl: normalize(org.fhirBaseUrl), partOf: null, location: formatStates(states) },
        [...(states?.keys() ?? [])],
      );
    }
  }

  return [...out.values()];
}
