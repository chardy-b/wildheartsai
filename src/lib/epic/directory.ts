import { z } from "zod";

export type Organization = { name: string; fhirBaseUrl: string };

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

export function parseEndpoints(json: unknown): Organization[] {
  const seen = new Set<string>();
  const orgs: Organization[] = [];
  for (const { resource } of bundleSchema.parse(json).entry) {
    if (resource.resourceType !== "Endpoint" || resource.status !== "active") continue;
    if (!resource.name?.trim() || !resource.address) continue;
    const fhirBaseUrl = normalize(resource.address);
    if (!fhirBaseUrl.startsWith("https://") || seen.has(fhirBaseUrl)) continue;
    seen.add(fhirBaseUrl);
    orgs.push({ name: resource.name.trim(), fhirBaseUrl });
  }
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

export function searchOrganizations(orgs: Organization[], query: string, limit = 20): Organization[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return orgs.filter((org) => words.every((word) => org.name.toLowerCase().includes(word))).slice(0, limit);
}

export function findOrganization(orgs: Organization[], fhirBaseUrl: string): Organization | undefined {
  const wanted = normalize(fhirBaseUrl);
  return orgs.find((org) => org.fhirBaseUrl === wanted);
}
