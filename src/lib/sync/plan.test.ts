import { describe, expect, it } from "vitest";
import { RECORD_QUERIES } from "@/lib/records";
import { effectiveDate } from "./dates";
import { diffResources, isEnteredInError, withoutMeta, type Fetched, type Stored } from "./diff";
import { FULL_PULL_EVERY_MS, interpretProbe, planQuery, probePath, searchPath, SYNC_QUERIES } from "./plan";

const now = new Date("2026-09-26T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
const lab = SYNC_QUERIES.find((q) => q.key === "Observation:lab")!;

describe("SYNC_QUERIES", () => {
  it("covers every record query with a unique, stable key", () => {
    expect(SYNC_QUERIES).toHaveLength(RECORD_QUERIES.length);
    expect(new Set(SYNC_QUERIES.map((q) => q.key)).size).toBe(SYNC_QUERIES.length);
    expect(SYNC_QUERIES.map((q) => q.key)).toEqual(expect.arrayContaining(["Observation:lab", "Observation:vital", "Condition:condition"]));
  });
});

describe("planQuery", () => {
  const synced = { lastSuccessAt: hoursAgo(2), lastFullAt: hoursAgo(24), supportsLastUpdated: true };

  it("pulls in full the first time, and whenever the server can't filter by update time", () => {
    expect(planQuery(undefined, now)).toEqual({ mode: "full" });
    expect(planQuery({ ...synced, supportsLastUpdated: false }, now)).toEqual({ mode: "full" });
    expect(planQuery({ ...synced, supportsLastUpdated: null }, now)).toEqual({ mode: "full" });
  });

  it("goes incremental from a day before the last success", () => {
    expect(planQuery(synced, now)).toEqual({ mode: "incremental", since: hoursAgo(26) });
  });

  it("pulls in full again once a week, to notice removed records", () => {
    const stale = { ...synced, lastFullAt: new Date(now.getTime() - FULL_PULL_EVERY_MS) };
    expect(planQuery(stale, now)).toEqual({ mode: "full" });
  });
});

describe("search paths", () => {
  it("adds _lastUpdated only for incremental searches", () => {
    expect(searchPath(lab, "p1", { mode: "full" })).toBe("Observation?patient=p1&category=laboratory");
    expect(searchPath(lab, "p1", { mode: "incremental", since: hoursAgo(26) })).toBe(
      "Observation?patient=p1&category=laboratory&_lastUpdated=gt2026-09-25T10%3A00%3A00.000Z",
    );
  });

  it("probes with a date in the future", () => {
    expect(probePath(lab, "p1", now)).toContain(encodeURIComponent("gt2026-09-27T12:00:00.000Z"));
  });
});

describe("interpretProbe", () => {
  it("reads an empty probe as supported, a repeat as ignored, and an error as unsupported", () => {
    expect(interpretProbe(5, { count: 0 })).toBe(true);
    expect(interpretProbe(5, { count: 5 })).toBe(false);
    expect(interpretProbe(5, { error: true })).toBe(false);
    expect(interpretProbe(0, { count: 0 })).toBeNull();
  });
});

describe("effectiveDate", () => {
  it("keeps partial dates as the start of their period, with their precision", () => {
    expect(effectiveDate("2019")).toEqual({ at: new Date("2019-01-01T00:00:00Z"), precision: "year" });
    expect(effectiveDate("2019-04")).toEqual({ at: new Date("2019-04-01T00:00:00Z"), precision: "month" });
    expect(effectiveDate("2019-04-05")).toEqual({ at: new Date("2019-04-05T00:00:00Z"), precision: "day" });
    expect(effectiveDate("2019-04-05T08:30:00-05:00")).toEqual({ at: new Date("2019-04-05T13:30:00Z"), precision: "instant" });
  });

  it("returns null for missing or unreadable dates", () => {
    expect(effectiveDate(null)).toBeNull();
    expect(effectiveDate("sometime")).toBeNull();
  });
});

describe("diffResources", () => {
  const fetched = (id: string, hmac: string, enteredInError = false): Fetched => ({
    resource: { resourceType: "Observation", id },
    hmac,
    enteredInError,
  });
  const stored = (fhirId: string, contentHmac: string, extra: Partial<Stored> = {}): Stored => ({
    id: `row-${fhirId}`,
    fhirId,
    contentHmac,
    removedAt: null,
    category: "lab",
    ...extra,
  });

  it("sorts fetched resources into new, changed and unchanged", () => {
    const diff = diffResources([fetched("a", "1"), fetched("b", "2"), fetched("c", "3")], [stored("b", "2"), stored("c", "old")], {});
    expect(diff.insert.map((f) => f.resource.id)).toEqual(["a"]);
    expect(diff.supersede.map((s) => s.stored.fhirId)).toEqual(["c"]);
    expect(diff.unchanged.map((s) => s.fhirId)).toEqual(["b"]);
    expect(diff.remove).toEqual([]);
  });

  it("treats a repeated entry as one resource", () => {
    expect(diffResources([fetched("a", "1"), fetched("a", "1")], [], {}).insert).toHaveLength(1);
  });

  it("only marks missing records removed after a full pull, and only in the query's category", () => {
    const rows = [stored("gone", "1"), stored("vital", "2", { category: "vital" }), stored("already", "3", { removedAt: now })];
    expect(diffResources([], rows, {}).remove).toEqual([]);
    expect(diffResources([], rows, { removalsIn: "lab" }).remove.map((s) => s.fhirId)).toEqual(["gone"]);
  });

  it("restores a removed record the source sends again", () => {
    const diff = diffResources([fetched("a", "1")], [stored("a", "1", { removedAt: now })], {});
    expect(diff.restore.map((s) => s.fhirId)).toEqual(["a"]);
  });

  it("recognises entered-in-error on status and on verificationStatus", () => {
    expect(isEnteredInError({ resourceType: "Observation", status: "entered-in-error" } as never)).toBe(true);
    expect(
      isEnteredInError({ resourceType: "Condition", verificationStatus: { coding: [{ code: "entered-in-error" }] } } as never),
    ).toBe(true);
    expect(isEnteredInError({ resourceType: "Observation", status: "final" } as never)).toBe(false);
  });

  it("drops meta before hashing, so a bumped lastUpdated alone isn't a change", () => {
    expect(withoutMeta({ resourceType: "Observation", id: "a", meta: { lastUpdated: "x" } } as never)).toEqual({
      resourceType: "Observation",
      id: "a",
    });
  });
});
