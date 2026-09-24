import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import type { Bundle, Resource } from "./types";

export async function fhirSearch<T extends Resource>({
  baseUrl,
  path,
  resourceType,
  accessToken,
  fetchImpl = fetch,
  maxPages = 5,
}: {
  baseUrl: string;
  path: string;
  resourceType: T["resourceType"];
  accessToken: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
}): Promise<T[]> {
  const root = baseUrl.replace(/\/+$/, "");
  const origin = new URL(root).origin;
  const results: T[] = [];
  let url: string | undefined = `${root}/${path}`;

  for (let page = 0; url && page < maxPages; page++) {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/fhir+json" },
      cache: "no-store",
    });
    if (response.status === 401) throw new ReconnectRequiredError();
    if (!response.ok) throw new EpicError("fhir", response.status);

    const bundle = (await response.json()) as Bundle;
    for (const entry of bundle.entry ?? []) {
      if (entry.resource?.resourceType === resourceType) results.push(entry.resource as T);
    }
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    url = next && new URL(next).origin === origin ? next : undefined;
  }
  return results;
}
