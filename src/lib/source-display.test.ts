import { describe, expect, it } from "vitest";
import { ago, categoryCounts, lastRunIssues, listOf } from "./source-display";

const now = new Date("2026-09-26T12:00:00Z");
const stats = (errorCode?: string) => ({ fetched: 0, inserted: 0, superseded: 0, unchanged: 0, removed: 0, ...(errorCode ? { errorCode } : {}) });

describe("ago", () => {
  it("reads naturally from seconds to days", () => {
    expect(ago(new Date(now.getTime() - 20_000), now)).toBe("just now");
    expect(ago(new Date(now.getTime() - 60_000), now)).toBe("1 minute ago");
    expect(ago(new Date(now.getTime() - 3 * 3600_000), now)).toBe("3 hours ago");
    expect(ago(new Date(now.getTime() - 50 * 3600_000), now)).toBe("2 days ago");
  });
});

describe("categoryCounts", () => {
  it("lists non-zero categories in dashboard order, ignoring unknown ones", () => {
    expect(categoryCounts({ visit: 3, lab: 412, allergy: 0, somethingElse: 5 })).toEqual([
      { category: "lab", label: "Lab results", count: 412 },
      { category: "visit", label: "Visits", count: 3 },
    ]);
  });
});

describe("lastRunIssues", () => {
  it("separates failed searches from ones with more records than one sync imports", () => {
    expect(
      lastRunIssues({ "Observation:lab": stats("truncated"), "Condition:condition": stats("500"), "Encounter:visit": stats(), "Nope:x": stats("403") }),
    ).toEqual({ failed: ["condition"], truncated: ["lab"] });
    expect(lastRunIssues(null)).toEqual({ failed: [], truncated: [] });
  });
});

describe("listOf", () => {
  it("joins words as a sentence", () => {
    expect(listOf([])).toBe("");
    expect(listOf(["labs"])).toBe("labs");
    expect(listOf(["labs", "notes", "visits"])).toBe("labs, notes and visits");
  });
});
