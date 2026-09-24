import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import type { Bundle, Resource } from "./types";

const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_RESOURCES = 200;
const DEFAULT_MAX_PAGE_BYTES = 2 * 1024 * 1024;

function fhirFailure(code: string): EpicError {
  return new EpicError("fhir", undefined, code);
}

function hasUnsafePathEncoding(pathname: string): boolean {
  // Reject encoded dot segments, path separators and nested percent-encoding.
  // Different proxies/frameworks decode these a different number of times.
  if (/%(?:2e|2f|5c|25)/i.test(pathname)) return true;
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes("\\") || decoded.split("/").some((segment) => segment === "." || segment === "..");
  } catch {
    return true;
  }
}

function configuredRoot(baseUrl: string): URL {
  let root: URL;
  try {
    root = new URL(baseUrl);
  } catch {
    throw fhirFailure("invalid_base");
  }
  if (
    root.protocol !== "https:" ||
    root.username !== "" ||
    root.password !== "" ||
    root.search !== "" ||
    root.hash !== "" ||
    hasUnsafePathEncoding(root.pathname)
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
  let candidate: URL;
  try {
    candidate = new URL(next, current);
  } catch {
    return undefined;
  }
  if (candidate.username !== "" || candidate.password !== "" || candidate.hash !== "" || hasUnsafePathEncoding(candidate.pathname)) {
    return undefined;
  }
  const rootPath = root.pathname.replace(/\/+$/, "");
  const withinPath = candidate.pathname === rootPath || candidate.pathname.startsWith(`${rootPath}/`);
  return candidate.origin === root.origin && withinPath ? candidate.toString() : undefined;
}

export async function fhirSearch<T extends Resource>({
  baseUrl,
  path,
  resourceType,
  accessToken,
  fetchImpl = fetch,
  maxPages = DEFAULT_MAX_PAGES,
  maxResources = DEFAULT_MAX_RESOURCES,
  maxPageBytes = DEFAULT_MAX_PAGE_BYTES,
}: {
  baseUrl: string;
  path: string;
  resourceType: T["resourceType"];
  accessToken: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
  maxResources?: number;
  maxPageBytes?: number;
}): Promise<T[]> {
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
      if (results.length >= maxResources) throw fhirFailure("resource_limit");
      results.push(entry.resource as T);
    }
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    url = next ? isAllowedNext(next, url, root) : undefined;
  }
  return results;
}
