import { describe, expect, it } from "vitest";
import { brandsBundle, r4List } from "@/test/epic-directory";
import { buildDirectory, searchTextFor, type DirectoryEntry } from "./brands";

const pick = (entries: DirectoryEntry[], name: string) => entries.filter((e) => e.name === name);

describe("buildDirectory", () => {
  it("lists each brand as an organization with its facilities' states, and each facility under it", () => {
    const entries = buildDirectory(
      brandsBundle([
        {
          name: "Northwind Health",
          address: "https://fhir.northwind.example/api/FHIR/R4/",
          facilities: [
            { name: "Northwind Rehab Brighton", city: "BRIGHTON", state: "MA" },
            { name: "Northwind Eye Clinic", city: "Nashua", state: "nh" },
            { name: "Northwind Lab", city: "Boston", state: "MA" },
            { name: "Northwind Health" },
          ],
        },
      ]),
      r4List([]),
    );
    expect(pick(entries, "Northwind Health")).toEqual([
      expect.objectContaining({ kind: "organization", fhirBaseUrl: "https://fhir.northwind.example/api/FHIR/R4", location: "MA, NH", partOf: null }),
    ]);
    expect(pick(entries, "Northwind Rehab Brighton")).toEqual([
      expect.objectContaining({ kind: "facility", partOf: "Northwind Health", location: "Brighton, MA" }),
    ]);
    expect(pick(entries, "Northwind Eye Clinic")[0].location).toBe("Nashua, NH");
    expect(entries).toHaveLength(4);
  });

  it("keeps the R4 spelling of an address listed in both, and R4's other names", () => {
    const entries = buildDirectory(
      brandsBundle([{ name: "Alder Valley", address: "https://ehr.alder.example/FHIR/api/fhir/R4" }]),
      r4List([{ name: "Alder Valley Clinics", address: "https://ehr.alder.example/FHIR/api/FHIR/R4/" }]),
    );
    expect(entries.map((e) => [e.name, e.fhirBaseUrl])).toEqual([
      ["Alder Valley", "https://ehr.alder.example/FHIR/api/FHIR/R4"],
      ["Alder Valley Clinics", "https://ehr.alder.example/FHIR/api/FHIR/R4"],
    ]);
  });

  it("uses the R4 address for a brand with the same name on the same host, but not on another host", () => {
    const entries = buildDirectory(
      brandsBundle([
        {
          name: "Cedar Health",
          address: "https://fhir.cedar.example/proxy/HOME/api/FHIR/R4",
          facilities: [{ name: "Cedar Pediatrics", city: "Austin", state: "TX" }],
        },
        // Same name as an R4 entry on an unrelated host: a different system.
        { name: "Summit Care", address: "https://summit-east.example/api/FHIR/R4", facilities: [{ name: "Summit Urology", state: "NJ" }] },
        { name: "Summit Care - West", address: "https://summit-west.example/fhir/WEST/api/FHIR/R4", facilities: [{ name: "Bend Clinic", state: "OR" }] },
      ]),
      r4List([
        { name: "Cedar Health", address: "https://fhir.cedar.example/proxy/api/FHIR/R4/" },
        { name: "Summit Care", address: "https://summit-west.example/fhir/api/FHIR/R4" },
      ]),
    );
    const cedar = "https://fhir.cedar.example/proxy/api/FHIR/R4";
    expect(pick(entries, "Cedar Health").map((e) => e.fhirBaseUrl)).toEqual([cedar]);
    expect(pick(entries, "Cedar Pediatrics")[0].fhirBaseUrl).toBe(cedar);

    expect(pick(entries, "Summit Care").map((e) => [e.fhirBaseUrl, e.location])).toEqual([
      ["https://summit-east.example/api/FHIR/R4", "NJ"],
      // The R4-only entry borrows the states of the one brand address on its host.
      ["https://summit-west.example/fhir/api/FHIR/R4", "OR"],
    ]);
  });

  it("skips inactive and unsafe endpoints, but keeps R4-only organizations", () => {
    const entries = buildDirectory(
      brandsBundle([
        { name: "Retired Clinic", address: "https://retired.example/api/FHIR/R4", status: "off" },
        { name: "Insecure Hospital", address: "http://insecure.example/api/FHIR/R4" },
        { name: "Traversal", address: "https://traversal.example/api/FHIR/R4/../oauth" },
      ]),
      r4List([{ name: "Birch Medical", address: "https://birch.example/api/FHIR/R4" }]),
    );
    expect(entries.map((e) => e.name)).toEqual(["Birch Medical"]);
    expect(entries[0].location).toBeNull();
  });

  it("summarizes many states, most facilities first", () => {
    const facilities = ["CA", "CA", "CA", "NV", "NV", "HI", "OR", "WA"].map((state, i) => ({ name: `Clinic ${i}`, state }));
    const [org] = buildDirectory(brandsBundle([{ name: "Pacific", address: "https://pacific.example/R4", facilities }]), r4List([])).filter(
      (e) => e.kind === "organization",
    );
    expect(org.location).toBe("CA, NV, HI and 2 more");
  });

  it("throws on something that isn't a bundle", () => {
    expect(() => buildDirectory({ entries: [] }, r4List([]))).toThrow(/Bundle/);
  });
});

describe("searchTextFor", () => {
  it("holds the name's words and adjacent pairs, then context words", () => {
    expect(searchTextFor("New York-Presbyterian", ["Northwind Health", "Brighton", "MA"])).toBe(
      " new york presbyterian newyork yorkpresbyterian | northwind health brighton ma ",
    );
    expect(searchTextFor("Clínica St. Luke's", [])).toBe(" clinica st lukes clinicast stlukes |  ");
  });
});
