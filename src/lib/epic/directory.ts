import { z } from "zod";
import { hasUnsafePathSyntax } from "@/lib/url-security";

// Epic sometimes lists several names for one FHIR address (for example a health
// system and its children's hospital). `name` is the shortest; the rest stay searchable.
export type Organization = { name: string; fhirBaseUrl: string; otherNames?: string[] };

export const EPIC_SANDBOX: Organization = {
  name: "Epic sandbox (sample patients)",
  fhirBaseUrl: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",
};

// Epic's published list of patient-facing R4 endpoints (open.epic.com → Endpoints):
// a FHIR Bundle of Endpoint resources whose `address` is the organization's FHIR base URL.
export const EPIC_ENDPOINTS_URL = "https://open.epic.com/Endpoints/R4";

const bundleSchema = z.object({
  resourceType: z.literal("Bundle"),
  entry: z.array(
    z.object({
      resource: z.object({
        resourceType: z.string(),
        status: z.string().optional(),
        name: z.string().optional(),
        address: z.string().optional(),
      }),
    }),
  ),
});

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function safeEndpointBase(value: string): string | undefined {
  const candidate = value.trim();
  if (!/^https:\/\//i.test(candidate) || hasUnsafePathSyntax(candidate)) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return undefined;
  }
  return normalize(parsed.toString());
}

export function parseEndpoints(json: unknown): Organization[] {
  const namesByUrl = new Map<string, string[]>();
  for (const { resource } of bundleSchema.parse(json).entry) {
    if (resource.resourceType !== "Endpoint" || resource.status !== "active") continue;
    const name = resource.name?.trim();
    if (!name || !resource.address) continue;
    const fhirBaseUrl = safeEndpointBase(resource.address);
    if (!fhirBaseUrl) continue;
    const names = namesByUrl.get(fhirBaseUrl) ?? [];
    if (!names.includes(name)) names.push(name);
    namesByUrl.set(fhirBaseUrl, names);
  }
  const orgs = [...namesByUrl].map(([fhirBaseUrl, names]): Organization => {
    const [name, ...otherNames] = [...names].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return otherNames.length ? { name, fhirBaseUrl, otherNames } : { name, fhirBaseUrl };
  });
  return orgs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadDirectory(
  environment: "sandbox" | "production",
  fetchImpl: typeof fetch = fetch,
): Promise<Organization[]> {
  if (environment === "sandbox") return [EPIC_SANDBOX];
  const response = await fetchImpl(EPIC_ENDPOINTS_URL, {
    headers: { Accept: "application/json" },
    next: { revalidate: 60 * 60 * 24 },
  });
  if (!response.ok) throw new Error(`Epic endpoint list responded ${response.status}`);
  return parseEndpoints(await response.json());
}

// Every organization a person may start a connection with. In production that is
// the real health systems plus Epic's sandbox, which is offered as sample data.
export async function loadConnectable(
  environment: "sandbox" | "production",
  fetchImpl: typeof fetch = fetch,
): Promise<Organization[]> {
  if (environment === "sandbox") return [EPIC_SANDBOX];
  return [EPIC_SANDBOX, ...(await loadDirectory("production", fetchImpl))];
}

export function isSampleData(org: { fhirBaseUrl: string }): boolean {
  return normalize(org.fhirBaseUrl) === EPIC_SANDBOX.fhirBaseUrl;
}

// What the connect screens offer. Production: search results among real health
// systems (only once there is a query), plus the sandbox as a separate sample-data
// option. Sandbox mode: just the sandbox. Anything already connected is left out.
export function organizationChoices(
  environment: "sandbox" | "production",
  connectable: Organization[],
  connectedUrls: Set<string>,
  query: string,
): { results: Organization[]; sample: Organization | null } {
  const available = connectable.filter((org) => !connectedUrls.has(org.fhirBaseUrl));
  if (environment === "sandbox") return { results: searchOrganizations(available, query), sample: null };
  const real = available.filter((org) => !isSampleData(org));
  return {
    results: query.trim() ? searchOrganizations(real, query) : [],
    sample: available.find(isSampleData) ?? null,
  };
}

// Words are lowercased, apostrophes dropped ("Luke's" -> "lukes") and split on anything else.
function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}

// Every query word must start a word in one of the organization's names, so
// "one" finds "One Brooklyn" but not "Langone" or "Cone".
export function searchOrganizations(orgs: Organization[], query: string, limit = 20): Organization[] {
  const wanted = wordsOf(query);
  return orgs
    .filter((org) =>
      [org.name, ...(org.otherNames ?? [])].some((name) => {
        const words = wordsOf(name);
        return wanted.every((w) => words.some((word) => word.startsWith(w)));
      }),
    )
    .slice(0, limit);
}

export function findOrganization(orgs: Organization[], fhirBaseUrl: string): Organization | undefined {
  const wanted = normalize(fhirBaseUrl);
  return orgs.find((org) => org.fhirBaseUrl === wanted);
}
