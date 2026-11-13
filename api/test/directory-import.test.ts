import { env } from "cloudflare:test";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDirectory, EPIC_BRANDS_URL } from "@/lib/epic/brands";
import { EPIC_ENDPOINTS_URL } from "@/lib/epic/directory";
import { brandsBundle, r4List } from "@/test/epic-directory";
import { searchDirectory } from "../src/data/directory";
import * as s from "../src/db/schema";
import { activate, cleanUp, downloadDirectory, writeSlice } from "../src/jobs/directory/import";
import { bundleEntries, NotABundleError, trimBrandEntry } from "../src/jobs/directory/stream";
import { clearAll, db } from "./helpers";

// The directory import on Workers: a streamed parse (the real list is ~95 MB, a Worker has
// 128 MB), slices written as a new generation, and searches switched to it in one statement.

function streamOf(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function collect(text: string, chunkSize: number) {
  const out: unknown[] = [];
  for await (const entry of bundleEntries(streamOf(text, chunkSize))) out.push(entry);
  return out;
}

// Made-up health systems, enough to pass the 500-organization check.
function largeBundle(systems: number, tag: string) {
  return brandsBundle(
    Array.from({ length: systems }, (_, i) => ({
      name: `${tag} Health ${i}`,
      address: `https://fhir${i}.${tag.toLowerCase()}.example/api/FHIR/R4`,
      facilities: [{ name: `${tag} Clinic ${i}`, city: "Springfield", state: i % 2 ? "IL" : "MA" }],
    })),
  );
}

function epicFetch(brands: unknown, r4: unknown = r4List([])) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === EPIC_BRANDS_URL) return new Response(JSON.stringify(brands));
    if (url === EPIC_ENDPOINTS_URL) return Response.json(r4);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(clearAll);
afterEach(() => vi.restoreAllMocks());

describe("streamed Brands parsing", () => {
  const bundle = brandsBundle([
    { name: 'Tricky "Quoted" {Braces} [Health]', address: "https://fhir.tricky.example/api/FHIR/R4", facilities: [{ name: "Back\\slash Clinic", city: "Boston", state: "MA" }] },
    { name: "Northwind Health", address: "https://fhir.northwind.example/api/FHIR/R4" },
  ]);
  // A nested "entry" key elsewhere must not be mistaken for the bundle's own.
  const text = JSON.stringify({ meta: { note: "entry", entry: [{ resourceType: "Decoy" }] }, ...bundle });

  it("yields every entry, whatever the chunk boundaries", async () => {
    for (const size of [1, 7, 64, 100_000]) expect(await collect(text, size)).toEqual(JSON.parse(text).entry);
  });

  it("keeps everything buildDirectory reads", () => {
    const trimmed = bundle.entry.map(trimBrandEntry);
    expect(buildDirectory({ resourceType: "Bundle", entry: trimmed }, r4List([]))).toEqual(buildDirectory(bundle, r4List([])));
  });

  it("refuses anything but a FHIR Bundle", async () => {
    await expect(collect(JSON.stringify({ resourceType: "OperationOutcome", entry: [] }), 5)).rejects.toThrow(NotABundleError);
    await expect(collect('{"resourceType": "Bundle", "entry": [{"a": 1}', 5)).rejects.toThrow(NotABundleError);
  });
});

describe("directory generations", () => {
  it("writes slices safely more than once, and switches searches only when activated", async () => {
    const first = await downloadDirectory(db, env.FILES, { fetchImpl: epicFetch(largeBundle(3, "Alpha")), minOrganizations: 1 });
    expect(first.changed).toBe(true);
    if (!first.changed) return;
    await writeSlice(db, env.FILES, first.generation, 0);
    await writeSlice(db, env.FILES, first.generation, 0);
    expect(await db.$count(s.epicDirectoryEntry)).toBe(first.total);
    // Written but not active: searches still see the previous directory (empty here).
    expect(await searchDirectory(db, "alpha")).toEqual([]);
    await activate(db, first, new Date());
    expect((await searchDirectory(db, "alpha")).length).toBe(3);

    // A changed list becomes a new generation; the old one stays searchable until the switch.
    const second = await downloadDirectory(db, env.FILES, { fetchImpl: epicFetch(largeBundle(2, "Beta")), minOrganizations: 1 });
    if (!second.changed) throw new Error("expected a change");
    await writeSlice(db, env.FILES, second.generation, 0);
    expect((await searchDirectory(db, "alpha")).length).toBe(3);
    expect(await searchDirectory(db, "beta")).toEqual([]);
    await activate(db, second, new Date(Date.now() + 1000));
    await cleanUp(db, env.FILES);
    expect(await searchDirectory(db, "alpha")).toEqual([]);
    expect((await searchDirectory(db, "beta")).length).toBe(2);
    expect(await db.$count(s.epicDirectoryEntry)).toBe(second.total);
    expect((await env.FILES.list({ prefix: "system/" })).objects).toEqual([]);
  });

  it("only records the check when nothing changed, and keeps the directory when the list looks partial", async () => {
    const fetchImpl = epicFetch(largeBundle(2, "Gamma"));
    const first = await downloadDirectory(db, env.FILES, { fetchImpl, minOrganizations: 1 });
    if (!first.changed) throw new Error("expected a change");
    await writeSlice(db, env.FILES, first.generation, 0);
    await activate(db, first, new Date());
    expect(await downloadDirectory(db, env.FILES, { fetchImpl, minOrganizations: 1 })).toMatchObject({ changed: false });
    expect(await db.$count(s.epicDirectoryImport)).toBe(2);
    await expect(downloadDirectory(db, env.FILES, { fetchImpl: epicFetch(largeBundle(1, "Delta")), minOrganizations: 500 })).rejects.toThrow(/only 1 organizations/);
    expect((await searchDirectory(db, "gamma")).length).toBe(2);
  });

  it("runs end to end as a Workflow", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(epicFetch(largeBundle(520, "Epsilon")));
    await using instance = await introspectWorkflowInstance(env.DIRECTORY_WORKFLOW, "directory-test");
    await env.DIRECTORY_WORKFLOW.create({ id: "directory-test" });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ changed: true, organizations: 520, facilities: 520, addresses: 520 });
    expect(await searchDirectory(db, "epsilon clinic 519")).toEqual([expect.objectContaining({ name: "Epsilon Clinic 519", partOf: "Epsilon Health 519" })]);
  });
});
