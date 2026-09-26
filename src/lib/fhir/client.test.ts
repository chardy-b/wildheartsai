import { describe, expect, it, vi } from "vitest";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import { fhirRead, fhirSearch, fhirSearchBounded } from "./client";

const base = "https://fhir.example.org/api/FHIR/R4";

function bundle(ids: string[], next?: string) {
  return Response.json({
    resourceType: "Bundle",
    link: next ? [{ relation: "next", url: next }] : [],
    entry: [
      ...ids.map((id) => ({ resource: { resourceType: "Condition", id } })),
      { resource: { resourceType: "OperationOutcome", id: "oo" } },
    ],
  });
}

describe("fhirSearch", () => {
  it("sends the bearer token and follows same-origin next links", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bundle(["a", "b"], `${base}/Condition?page=2`))
      .mockResolvedValueOnce(bundle(["c"]));
    const results = await fhirSearch({ baseUrl: `${base}/`, path: "Condition?patient=p1", resourceType: "Condition", accessToken: "at", fetchImpl });

    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${base}/Condition?patient=p1`);
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer at", Accept: "application/fhir+json" });
    expect(fetchImpl.mock.calls[1][0]).toBe(`${base}/Condition?page=2`);
  });

  it("ignores next links on another origin", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(bundle(["a"], "https://evil.example/steal"));
    const results = await fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl });
    expect(results).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("ignores same-origin next links outside the configured FHIR base path", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(bundle(["a"], "https://fhir.example.org/oauth/introspect"));
    const results = await fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl });
    expect(results).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    `${base}%2f%2e%2e%2foauth/introspect`,
    `${base}%252f%252e%252e%252foauth/introspect`,
    `${base}/Condition/../Patient?page=2`,
    `${base}/Condition/%2e%2e/Patient?page=2`,
    `${base}/Condition\\..\\Patient?page=2`,
    "https://user:password@fhir.example.org/api/FHIR/R4/Condition?page=2",
  ])("ignores unsafe pagination links: %s", async (next) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(bundle(["a"], next));
    const results = await fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl });
    expect(results).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects an initial search path outside the configured FHIR base", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fhirSearch({ baseUrl: base, path: "/oauth/introspect", resourceType: "Condition", accessToken: "at", fetchImpl }),
    ).rejects.toMatchObject({ stage: "fhir", code: "invalid_path" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects encoded traversal in an initial search path", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fhirSearch({ baseUrl: base, path: "Condition%2f%2e%2e%2foauth", resourceType: "Condition", accessToken: "at", fetchImpl }),
    ).rejects.toMatchObject({ stage: "fhir", code: "invalid_path" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects credentialed configured FHIR base URLs", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fhirSearch({
        baseUrl: "https://user:password@fhir.example.org/api/FHIR/R4",
        path: "Condition",
        resourceType: "Condition",
        accessToken: "at",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ stage: "fhir", code: "invalid_base" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follows relative next links only within the configured FHIR base path", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bundle(["a"], "Condition?page=2"))
      .mockResolvedValueOnce(bundle(["b"]));
    const results = await fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl });
    expect(results.map((resource) => resource.id)).toEqual(["a", "b"]);
    expect(fetchImpl.mock.calls[1][0]).toBe(`${base}/Condition?page=2`);
  });

  it("rejects oversized response bodies before retaining them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(bundle(["a"]));
    await expect(
      fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl, maxPageBytes: 8 }),
    ).rejects.toMatchObject({ stage: "fhir", code: "response_too_large" });
  });

  it("rejects searches that exceed the resource cap", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(bundle(["a", "b"]));
    await expect(
      fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl, maxResources: 1 }),
    ).rejects.toMatchObject({ stage: "fhir", code: "resource_limit" });
  });

  it("reports an error instead of returning partial results after maxPages", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => bundle(["x"], `${base}/Condition?page=next`));
    await expect(
      fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl, maxPages: 3 }),
    ).rejects.toMatchObject({ stage: "fhir", code: "page_limit" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("asks for a reconnect on 401 and reports other failures", async () => {
    const unauthorized = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    await expect(
      fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl: unauthorized }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);

    const broken = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    await expect(
      fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl: broken }),
    ).rejects.toMatchObject({ stage: "fhir", status: 500 } satisfies Partial<EpicError>);
  });
});

describe("fhirRead", () => {
  const base = "https://fhir.example.org/api/FHIR/R4";

  it("reads one resource by a relative or absolute address within the connection's base", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => Response.json({ resourceType: "Binary", id: "b1", contentType: "text/plain", data: "SGk=" }));
    expect(await fhirRead({ baseUrl: base, path: "Binary/b1", accessToken: "at", fetchImpl })).toMatchObject({ resourceType: "Binary", id: "b1" });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${base}/Binary/b1`);
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer at" });
    await fhirRead({ baseUrl: base, path: `${base}/Binary/b1`, accessToken: "at", fetchImpl });
    expect(fetchImpl.mock.calls[1][0]).toBe(`${base}/Binary/b1`);
  });

  it("refuses addresses outside the connection's base without sending the token", async () => {
    const fetchImpl = vi.fn();
    for (const path of ["https://evil.example/Binary/b1", "../../oauth2/token", "https://fhir.example.org/other/Binary/b1"]) {
      await expect(fhirRead({ baseUrl: base, path, accessToken: "at", fetchImpl })).rejects.toMatchObject({ stage: "fhir", code: "invalid_path" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks for a reconnect on 401 and enforces the size limit", async () => {
    await expect(fhirRead({ baseUrl: base, path: "Binary/b1", accessToken: "at", fetchImpl: vi.fn().mockResolvedValue(new Response("", { status: 401 })) })).rejects.toBeInstanceOf(ReconnectRequiredError);
    const big = vi.fn().mockResolvedValue(new Response(JSON.stringify({ resourceType: "Binary", data: "x".repeat(2000) })));
    await expect(fhirRead({ baseUrl: base, path: "Binary/b1", accessToken: "at", fetchImpl: big, maxBytes: 100 })).rejects.toMatchObject({ code: "response_too_large" });
  });
});

describe("fhirSearchBounded", () => {
  it("returns what it fetched, flagged as truncated, when a search reaches its resource cap", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(bundle(["a", "b", "c"], `${base}/Condition?page=2`));
    const result = await fhirSearchBounded({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl, maxResources: 2 });
    expect(result).toEqual({ resources: [expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "b" })], truncated: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("flags a search that still has pages left after maxPages", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => bundle(["x"], `${base}/Condition?page=next`));
    const result = await fhirSearchBounded({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl, maxPages: 3 });
    expect(result.resources).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("is not truncated when everything fits, and still fails on real errors", async () => {
    const complete = await fhirSearchBounded({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl: vi.fn().mockResolvedValue(bundle(["a"])) });
    expect(complete).toEqual({ resources: [expect.objectContaining({ id: "a" })], truncated: false });
    await expect(
      fhirSearchBounded({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl: vi.fn().mockResolvedValue(new Response("", { status: 500 })) }),
    ).rejects.toMatchObject({ stage: "fhir", status: 500 });
  });
});
