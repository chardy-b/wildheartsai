import { describe, expect, it, vi } from "vitest";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import { fhirSearch } from "./client";

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

  it("stops after maxPages", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => bundle(["x"], `${base}/Condition?page=next`));
    await fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl, maxPages: 3 });
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
