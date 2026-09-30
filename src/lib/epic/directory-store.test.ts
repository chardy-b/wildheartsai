import { beforeEach, describe, expect, it, vi } from "vitest";
import { epicDirectoryEntry, epicDirectoryImport } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createTestDb } from "@/test/db";
import { brandsBundle, r4List } from "@/test/epic-directory";
import { EPIC_BRANDS_URL } from "./brands";
import { EPIC_ENDPOINTS_URL, EPIC_SANDBOX } from "./directory";
import { importEpicDirectory } from "./directory-import";
import { connectChoices, directoryLoaded, findConnectable, searchDirectory } from "./directory-store";

const NORTHWIND = "https://fhir.northwind.example/api/FHIR/R4";
const MINUTE = "https://retail.minute.example/api/FHIR/R4";
const CONE = "https://fhir.cone.example/api/FHIR/R4";
const SHARED = "https://shared.presby.example/api/FHIR/R4";
const BIRCH = "https://birch.example/api/FHIR/R4";

const brands = brandsBundle([
  {
    name: "Northwind Health",
    address: NORTHWIND,
    facilities: [
      { name: "Spaulding Outpatient Center Brighton", city: "Brighton", state: "MA" },
      { name: "Northwind Lab", city: "Boston", state: "MA" },
      { name: "Pardee Clinic", city: "Hendersonville", state: "NC" },
    ],
  },
  { name: "Minute Clinic", address: MINUTE, facilities: [{ name: "CVS/MinuteClinic - Charlotte", city: "Charlotte", state: "NC" }] },
  { name: "Cone Health", address: CONE },
  { name: "Weill Medicine", address: SHARED, facilities: [{ name: "Presby Eye Clinic", city: "New York", state: "NY" }] },
]);
const r4 = r4List([
  { name: "Columbia Doctors", address: SHARED },
  { name: "New York-Presbyterian", address: SHARED },
  // The same name spelled differently: not repeated as another name.
  { name: "New York Presbyterian", address: SHARED },
  { name: "Birch Medical Center", address: BIRCH },
]);

function epicFetch(overrides: Record<string, Response> = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const key = String(url);
    if (overrides[key]) return overrides[key];
    if (key === EPIC_BRANDS_URL) return Response.json(brands);
    if (key === EPIC_ENDPOINTS_URL) return Response.json(r4);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

async function loaded(db: Db) {
  await importEpicDirectory(db, { fetchImpl: epicFetch(), minOrganizations: 1 });
}

const names = (orgs: { name: string }[]) => orgs.map((o) => o.name);

describe("importEpicDirectory", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("stores the merged directory once, and only records the check when nothing changed", async () => {
    const fetchImpl = epicFetch();
    expect(await directoryLoaded(db)).toBe(false);
    expect(await importEpicDirectory(db, { fetchImpl, minOrganizations: 1 })).toEqual({
      changed: true,
      organizations: 8,
      facilities: 5,
      addresses: 5,
    });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    expect(await directoryLoaded(db)).toBe(true);

    expect(await importEpicDirectory(db, { fetchImpl, minOrganizations: 1 })).toMatchObject({ changed: false });
    expect(await db.$count(epicDirectoryEntry)).toBe(13);
    expect(await db.$count(epicDirectoryImport)).toBe(2);
  });

  it("keeps the stored directory when a download fails or looks partial", async () => {
    await loaded(db);
    await expect(
      importEpicDirectory(db, { fetchImpl: epicFetch({ [EPIC_BRANDS_URL]: new Response("down", { status: 503 }) }), minOrganizations: 1 }),
    ).rejects.toThrow(/503/);
    await expect(importEpicDirectory(db, { fetchImpl: epicFetch(), minOrganizations: 500 })).rejects.toThrow(/only 8 organizations/);
    expect(await db.$count(epicDirectoryEntry)).toBe(13);
  });
});

describe("searchDirectory", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await loaded(db);
  });

  it("finds a clinic by its own name, under its health system", async () => {
    expect(await searchDirectory(db, "spaulding")).toEqual([
      { name: "Spaulding Outpatient Center Brighton", fhirBaseUrl: NORTHWIND, partOf: "Northwind Health", location: "Brighton, MA" },
    ]);
    expect(names(await searchDirectory(db, "pardee"))).toEqual(["Pardee Clinic"]);
    // Not "also listed as" the other systems sharing its address: it belongs to one of them.
    expect(await searchDirectory(db, "presby eye")).toEqual([
      { name: "Presby Eye Clinic", fhirBaseUrl: SHARED, partOf: "Weill Medicine", location: "New York, NY" },
    ]);
  });

  it("shows each address once, as the health system when its name matches", async () => {
    expect(await searchDirectory(db, "northwind")).toEqual([{ name: "Northwind Health", fhirBaseUrl: NORTHWIND, location: "MA, NC" }]);
    // Matched through the city only: the clinic in that city stands for the system.
    expect(await searchDirectory(db, "boston")).toEqual([
      { name: "Northwind Lab", fhirBaseUrl: NORTHWIND, partOf: "Northwind Health", location: "Boston, MA" },
    ]);
  });

  it("matches the start of words, and names written without their spaces", async () => {
    expect(names(await searchDirectory(db, "one"))).toEqual([]);
    expect(names(await searchDirectory(db, "minuteclinic"))).toEqual(["Minute Clinic"]);
    expect(await searchDirectory(db, "NewYork-Presbyterian")).toEqual([
      { name: "New York Presbyterian", fhirBaseUrl: SHARED, location: "NY", otherNames: ["Weill Medicine", "Columbia Doctors"] },
    ]);
  });

  it("drops generic words when every word together matches nothing", async () => {
    expect(names(await searchDirectory(db, "Birch Health"))).toEqual(["Birch Medical Center"]);
    expect(names(await searchDirectory(db, "health"))).toEqual(["Cone Health", "Northwind Health"]);
  });

  it("leaves out excluded addresses and returns nothing for an empty query", async () => {
    expect(await searchDirectory(db, "northwind", { exclude: [NORTHWIND] })).toEqual([]);
    expect(await searchDirectory(db, " -- ")).toEqual([]);
  });
});

describe("connectChoices", () => {
  it("searches Epic's R4 list until the directory has been imported", async () => {
    const db = await createTestDb();
    const fetchImpl = epicFetch();
    const before = await connectChoices(db, "production", "birch", new Set(), fetchImpl);
    expect(before).toEqual({ results: [{ name: "Birch Medical Center", fhirBaseUrl: BIRCH }], sample: EPIC_SANDBOX });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([EPIC_ENDPOINTS_URL]);

    await loaded(db);
    const after = await connectChoices(db, "production", "spaulding", new Set([EPIC_SANDBOX.fhirBaseUrl]), vi.fn());
    expect(after).toEqual({ results: [expect.objectContaining({ partOf: "Northwind Health" })], sample: null });
    expect((await connectChoices(db, "production", "", new Set(), vi.fn())).results).toEqual([]);
  });

  it("offers only the sandbox in sandbox mode", async () => {
    const db = await createTestDb();
    await loaded(db);
    expect(await connectChoices(db, "sandbox", "northwind", new Set(), vi.fn())).toEqual({ results: [], sample: null });
    expect(await connectChoices(db, "sandbox", "", new Set(), vi.fn())).toEqual({ results: [EPIC_SANDBOX], sample: null });
  });
});

describe("findConnectable", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await loaded(db);
  });

  it("names a directory address as chosen, when that name is listed there", async () => {
    expect(await findConnectable(db, "production", `${SHARED}/`, "Columbia Doctors", vi.fn())).toEqual({
      name: "Columbia Doctors",
      fhirBaseUrl: SHARED,
    });
    // A clinic's or unknown name falls back to the address's shortest listed name.
    expect((await findConnectable(db, "production", SHARED, "Pardee Clinic", vi.fn()))?.name).toBe("Weill Medicine");
    expect((await findConnectable(db, "production", NORTHWIND, undefined, vi.fn()))?.name).toBe("Northwind Health");
  });

  it("accepts any R4 address, the sandbox, and nothing else", async () => {
    const onlyInR4 = "https://legacy.example/api/FHIR/R4";
    const fetchImpl = epicFetch({ [EPIC_ENDPOINTS_URL]: Response.json(r4List([{ name: "Legacy Health", address: onlyInR4 }])) });
    expect(await findConnectable(db, "production", onlyInR4, undefined, fetchImpl)).toEqual({ name: "Legacy Health", fhirBaseUrl: onlyInR4 });
    expect(await findConnectable(db, "production", "https://evil.example/api/FHIR/R4", undefined, epicFetch())).toBeUndefined();
    expect(await findConnectable(db, "production", EPIC_SANDBOX.fhirBaseUrl, undefined, vi.fn())).toEqual(EPIC_SANDBOX);
    expect(await findConnectable(db, "sandbox", NORTHWIND, undefined, vi.fn())).toBeUndefined();
  });
});
