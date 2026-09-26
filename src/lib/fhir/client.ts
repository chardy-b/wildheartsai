import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import { hasUnsafePathSyntax } from "@/lib/url-security";
import type { Bundle, Resource } from "./types";

const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_RESOURCES = 200;
const DEFAULT_MAX_PAGE_BYTES = 2 * 1024 * 1024;

function fhirFailure(code: string): EpicError {
  return new EpicError("fhir", undefined, code);
}

function configuredRoot(baseUrl: string): URL {
  const candidate = baseUrl.trim();
  if (!/^https:\/\//i.test(candidate) || hasUnsafePathSyntax(candidate)) throw fhirFailure("invalid_base");

  let root: URL;
  try {
    root = new URL(candidate);
  } catch {
    throw fhirFailure("invalid_base");
  }
  if (
    root.protocol !== "https:" ||
    root.username !== "" ||
    root.password !== "" ||
    root.search !== "" ||
    root.hash !== ""
  ) {
    throw fhirFailure("invalid_base");
  }
  root.pathname = `${root.pathname.replace(/\/+$/, "")}/`;
  return root;
}

async function jsonWithinLimit(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw fhirFailure("response_too_large");
  if (!response.body) throw fhirFailure("empty_response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw fhirFailure("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw fhirFailure("invalid_json");
  }
}

function isAllowedNext(next: string, current: string, root: URL): string | undefined {
  const raw = next.trim();
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(raw);
  if (hasUnsafePathSyntax(raw) || (explicitScheme && !/^[a-z][a-z\d+.-]*:\/\//i.test(raw))) return undefined;

  let candidate: URL;
  try {
    candidate = new URL(raw, current);
  } catch {
    return undefined;
  }
  if (candidate.username !== "" || candidate.password !== "" || candidate.hash !== "") {
    return undefined;
  }
  const rootPath = root.pathname.replace(/\/+$/, "");
  const withinPath = candidate.pathname === rootPath || candidate.pathname.startsWith(`${rootPath}/`);
  return candidate.origin === root.origin && withinPath ? candidate.toString() : undefined;
}

type SearchOptions<T extends Resource> = {
  baseUrl: string;
  path: string;
  resourceType: T["resourceType"];
  accessToken: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
  maxResources?: number;
  maxPageBytes?: number;
};

// Follows same-origin `next` links. Stops early, without failing, when a cap is
// reached, and says which one so callers can decide whether partial is acceptable.
async function searchPages<T extends Resource>({
  baseUrl,
  path,
  resourceType,
  accessToken,
  fetchImpl = fetch,
  maxPages = DEFAULT_MAX_PAGES,
  maxResources = DEFAULT_MAX_RESOURCES,
  maxPageBytes = DEFAULT_MAX_PAGE_BYTES,
}: SearchOptions<T>): Promise<{ resources: T[]; stoppedAt: "resource_limit" | "page_limit" | null }> {
  const root = configuredRoot(baseUrl);
  const results: T[] = [];
  const initial = isAllowedNext(path, root.toString(), root);
  if (!initial) throw fhirFailure("invalid_path");
  let url: string | undefined = initial;

  for (let page = 0; url && page < maxPages; page++) {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/fhir+json" },
      cache: "no-store",
    });
    if (response.status === 401) throw new ReconnectRequiredError();
    if (!response.ok) throw new EpicError("fhir", response.status);

    const bundle = (await jsonWithinLimit(response, maxPageBytes)) as Bundle;
    if (bundle.resourceType !== "Bundle") throw fhirFailure("invalid_bundle");
    for (const entry of bundle.entry ?? []) {
      if (entry.resource?.resourceType !== resourceType) continue;
      if (results.length >= maxResources) return { resources: results, stoppedAt: "resource_limit" };
      results.push(entry.resource as T);
    }
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    url = next ? isAllowedNext(next, url, root) : undefined;
  }
  return { resources: results, stoppedAt: url ? "page_limit" : null };
}

// Every matching resource, or an error: never silently partial.
export async function fhirSearch<T extends Resource>(options: SearchOptions<T>): Promise<T[]> {
  const { resources, stoppedAt } = await searchPages(options);
  if (stoppedAt) throw fhirFailure(stoppedAt);
  return resources;
}

// Up to the caps, with `truncated` saying whether more existed. For views that
// show what they have and tell the person some records weren't loaded.
export async function fhirSearchBounded<T extends Resource>(options: SearchOptions<T>): Promise<{ resources: T[]; truncated: boolean }> {
  const { resources, stoppedAt } = await searchPages(options);
  return { resources, truncated: stoppedAt !== null };
}

// Reads one resource (for example a note's Binary) at an address inside the
// connection's FHIR base, with the same address checks and size limit as searches.
export async function fhirRead<T extends Resource = Resource>({
  baseUrl,
  path,
  accessToken,
  fetchImpl = fetch,
  maxBytes = DEFAULT_MAX_PAGE_BYTES,
}: {
  baseUrl: string;
  path: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}): Promise<T> {
  const root = configuredRoot(baseUrl);
  const url = isAllowedNext(path, root.toString(), root);
  if (!url) throw fhirFailure("invalid_path");

  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/fhir+json" },
    cache: "no-store",
  });
  if (response.status === 401) throw new ReconnectRequiredError();
  if (!response.ok) throw new EpicError("fhir", response.status);
  const resource = (await jsonWithinLimit(response, maxBytes)) as T;
  if (typeof resource?.resourceType !== "string") throw fhirFailure("invalid_resource");
  return resource;
}
