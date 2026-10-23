import { describe, expect, it } from "vitest";
import { analyticsUrl, trafficRoute } from "./traffic-route";

describe("traffic redaction", () => {
  it("removes record identifiers, health categories, tokens and unknown paths", () => {
    expect(analyticsUrl("https://example.com/app/wildcards/private-document?token=secret#private"))
      .toBe("https://example.com/app/wildcards/[id]");
    expect(trafficRoute("/app/records/private-condition")).toBe("/app/records/[category]");
    expect(analyticsUrl("https://example.com/reset-password?token=secret")).toBe("https://example.com/reset-password");
    expect(trafficRoute("/private-person/private-document")).toBe("/other");
    expect(trafficRoute("/app/wildcards/workbench/")).toBe("/app/wildcards/workbench");
  });
});
