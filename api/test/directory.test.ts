import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDirectory } from "@/lib/epic/brands";
import { EPIC_ENDPOINTS_URL, EPIC_SANDBOX } from "@/lib/epic/directory";
import { brandsBundle, r4List } from "@/test/epic-directory";
import { connectChoices, findConnectable, searchDirectory } from "../src/data/directory";
import * as s from "../src/db/schema";
import { clearAll, db } from "./helpers";

// Ported from src/lib/epic/directory-store.test.ts, with the same fixtures and expectations: the
// SQLite query (window function, instr) must rank exactly as the Postgres one (DISTINCT ON).
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
  { name: "New York Presbyterian", address: SHARED },
  { name: "Birch Medical Center", address: BIRCH },
]);

const r4Fetch = (list: unknown = r4) =>
  vi.fn(async (url: string | URL | Request) => (String(url) === EPIC_ENDPOINTS_URL ? Response.json(list) : new Response("not found", { status: 404 }))) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

// Stores the merged directory as the import does (the import itself is Phase 4).
async function loaded() {
  const entries = buildDirectory(brands, r4);
  // Six columns per row: 16 rows stay under D1's 100 bound parameters.
  for (let i = 0; i < entries.length; i += 16) await db.insert(s.epicDirectoryEntry).values(entries.slice(i, i + 16));
  await db.insert(s.epicDirectoryImport).values({ contentHash: "test", changed: true, organizations: 1, facilities: 1, addresses: 1 });
}

const names = (orgs: { name: string }[]) => orgs.map((o) => o.name);

beforeEach(clearAll);

describe("searchDirectory on D1", () => {
  beforeEach(loaded);

  it("finds a clinic by its own name, under its health system", async () => {
    expect(await searchDirectory(db, "spaulding")).toEqual([
      { name: "Spaulding Outpatient Center Brighton", fhirBaseUrl: NORTHWIND, partOf: "Northwind Health", location: "Brighton, MA" },
    ]);
    expect(names(await searchDirectory(db, "pardee"))).toEqual(["Pardee Clinic"]);
    expect(await searchDirectory(db, "presby eye")).toEqual([{ name: "Presby Eye Clinic", fhirBaseUrl: SHARED, partOf: "Weill Medicine", location: "New York, NY" }]);
  });

  it("shows each address once, as the health system when its name matches", async () => {
    expect(await searchDirectory(db, "northwind")).toEqual([{ name: "Northwind Health", fhirBaseUrl: NORTHWIND, location: "MA, NC" }]);
    expect(await searchDirectory(db, "boston")).toEqual([{ name: "Northwind Lab", fhirBaseUrl: NORTHWIND, partOf: "Northwind Health", location: "Boston, MA" }]);
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

describe("connectChoices and findConnectable on D1", () => {
  it("searches Epic's R4 list until the directory has been imported", async () => {
    const fetchImpl = r4Fetch();
    expect(await connectChoices(db, "production", "birch", new Set(), fetchImpl)).toEqual({ results: [{ name: "Birch Medical Center", fhirBaseUrl: BIRCH }], sample: EPIC_SANDBOX });
    await loaded();
    const after = await connectChoices(db, "production", "spaulding", new Set([EPIC_SANDBOX.fhirBaseUrl]), vi.fn());
    expect(after).toEqual({ results: [expect.objectContaining({ partOf: "Northwind Health" })], sample: null });
    expect(await connectChoices(db, "sandbox", "northwind", new Set(), vi.fn())).toEqual({ results: [], sample: null });
  });

  it("connects only a directory address, an R4 address or the sandbox", async () => {
    await loaded();
    expect(await findConnectable(db, "production", `${SHARED}/`, "Columbia Doctors", vi.fn())).toEqual({ name: "Columbia Doctors", fhirBaseUrl: SHARED });
    expect((await findConnectable(db, "production", SHARED, "Pardee Clinic", vi.fn()))?.name).toBe("Weill Medicine");
    const onlyInR4 = "https://legacy.example/api/FHIR/R4";
    expect(await findConnectable(db, "production", onlyInR4, undefined, r4Fetch(r4List([{ name: "Legacy Health", address: onlyInR4 }])))).toEqual({ name: "Legacy Health", fhirBaseUrl: onlyInR4 });
    expect(await findConnectable(db, "production", "https://evil.example/fhir", undefined, r4Fetch())).toBeUndefined();
    expect(await findConnectable(db, "sandbox", NORTHWIND, undefined, vi.fn())).toBeUndefined();
    expect(await findConnectable(db, "sandbox", EPIC_SANDBOX.fhirBaseUrl, undefined, vi.fn())).toEqual(EPIC_SANDBOX);
  });
});
