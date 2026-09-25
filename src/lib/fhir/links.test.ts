import { describe, expect, it } from "vitest";
import { noteAttachment, notesForVisit } from "./links";
import type { RecordItem } from "./normalize";
import type { Resource } from "./types";

const item = (category: RecordItem["category"], resource: Record<string, unknown>, connectionId = "c1"): RecordItem => ({
  key: `${connectionId}|${resource.resourceType}/${resource.id}`,
  category,
  title: "t",
  date: null,
  detail: null,
  status: null,
  source: "North Clinic",
  resource: resource as Resource,
  connectionId,
});

describe("noteAttachment", () => {
  it("prefers HTML, then RTF, then plain text, and ignores formats we can't show", () => {
    const content = (types: string[]) => ({ resourceType: "DocumentReference", content: types.map((t, i) => ({ attachment: { contentType: t, url: `Binary/${i}` } })) }) as Resource;
    expect(noteAttachment(content(["application/pdf", "text/rtf", "text/html"]))).toEqual({ url: "Binary/2", contentType: "text/html" });
    expect(noteAttachment(content(["text/rtf", "text/plain"]))).toEqual({ url: "Binary/0", contentType: "text/rtf" });
    expect(noteAttachment(content(["application/pdf"]))).toBeNull();
    expect(noteAttachment({ resourceType: "DocumentReference" } as Resource)).toBeNull();
  });
});

describe("notesForVisit", () => {
  it("finds notes from the same connection that point at the visit", () => {
    const visit = item("visit", { resourceType: "Encounter", id: "e1" });
    const mine = item("note", { resourceType: "DocumentReference", id: "d1", context: { encounter: [{ reference: "Encounter/e1" }] } });
    const absolute = item("note", { resourceType: "DocumentReference", id: "d2", context: { encounter: [{ reference: "https://north.example/R4/Encounter/e1" }] } });
    const otherVisit = item("note", { resourceType: "DocumentReference", id: "d3", context: { encounter: [{ reference: "Encounter/e2" }] } });
    const otherConnection = item("note", { resourceType: "DocumentReference", id: "d4", context: { encounter: [{ reference: "Encounter/e1" }] } }, "c2");
    expect(notesForVisit(visit, [visit, mine, absolute, otherVisit, otherConnection]).map((n) => n.resource.id)).toEqual(["d1", "d2"]);
  });
});
