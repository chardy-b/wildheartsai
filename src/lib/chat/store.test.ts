import { describe, expect, it } from "vitest";
import { summaryCoverageAsOf } from "./store";

describe("summary coverage timestamp", () => {
  it("is unknown when any cited source has no completed sync, independent of row order", () => {
    const known = new Date("2026-10-01T00:00:00.000Z");
    expect(summaryCoverageAsOf([{ lastSyncedAt: known }, { lastSyncedAt: null }])).toBeNull();
    expect(summaryCoverageAsOf([{ lastSyncedAt: null }, { lastSyncedAt: known }])).toBeNull();
  });

  it("uses the oldest timestamp only when every cited source has a known sync", () => {
    const older = new Date("2026-09-30T00:00:00.000Z");
    const newer = new Date("2026-10-01T00:00:00.000Z");
    expect(summaryCoverageAsOf([{ lastSyncedAt: newer }, { lastSyncedAt: older }])).toEqual(older);
  });
});
