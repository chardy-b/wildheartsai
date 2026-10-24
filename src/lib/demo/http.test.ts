import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getSession: vi.fn(), snapshot: vi.fn(), populate: vi.fn(), document: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/records-keys", () => ({ recordsKey: () => Buffer.alloc(32) }));
vi.mock("./store", () => ({ demoSnapshot: mocks.snapshot, populateDemo: mocks.populate, importDemoDocument: mocks.document }));
import { demoRequest } from "./http";
import { DEMO_USER_ID } from "./scenario";
import { demoPdf } from "./pdf";

const request = (method = "GET", body?: Uint8Array) => new Request("https://app.example/api/demo/snapshot", { method, headers: { origin: "https://app.example" }, ...(body ? { body: new Uint8Array(body) } : {}) });
beforeEach(() => { vi.stubEnv("DEMO_ENABLED", "1"); vi.clearAllMocks(); mocks.getSession.mockResolvedValue({ user: { id: DEMO_USER_ID, emailVerified: true } }); mocks.snapshot.mockResolvedValue({ anchor: "2026-10-21", sources: [], records: [] }); });
afterEach(() => vi.unstubAllEnvs());

describe("demo access boundary", () => {
  it("requires a verified normal session and the fixed seeded identity with the gate enabled", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await demoRequest(request(), ["snapshot"])).status).toBe(401);
    mocks.getSession.mockResolvedValueOnce({ user: { id: "another-user", email: "demo@wildhearts.localhost", emailVerified: true } });
    expect((await demoRequest(request(), ["snapshot"])).status).toBe(404);
    vi.stubEnv("DEMO_ENABLED", "0");
    expect((await demoRequest(request(), ["snapshot"])).status).toBe(404);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it("rejects cross-origin mutation, arbitrary documents and oversized uploads", async () => {
    const cross = new Request("https://app.example/api/demo/reset", { method: "POST", headers: { origin: "https://other.example" } });
    expect((await demoRequest(cross, ["reset"])).status).toBe(403);
    expect((await demoRequest(request("POST", Buffer.from("%PDF-something else")), ["document"])).status).toBe(422);
    expect((await demoRequest(request("POST", Buffer.alloc(64001)), ["document"])).status).toBe(413);
    expect(mocks.populate).not.toHaveBeenCalled(); expect(mocks.document).not.toHaveBeenCalled();
  });
  it("accepts only the generated PDF, scopes the write and disables caching", async () => {
    const result = await demoRequest(request("POST", demoPdf()), ["document"]);
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.document).toHaveBeenCalledWith({}, expect.any(Buffer), DEMO_USER_ID);
    const pdf = await demoRequest(request(), ["sample.pdf"]);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).equals(demoPdf())).toBe(true);
  });
  it("searches the owned synthetic snapshot and labels the FHIR response as local, not Medplum", async () => {
    mocks.snapshot.mockResolvedValue({ records: [{ id: "local-1", resourceType: "Observation", resource: { resourceType: "Observation", code: { text: "Ferritin" } } }, { id: "local-2", resourceType: "Condition", resource: { resourceType: "Condition" } }] });
    const result = await demoRequest(new Request("https://app.example/api/demo/fhir?type=Observation&q=ferritin&userId=another-user"), ["fhir"]);
    const body = await result.json(); expect(body.total).toBe(1); expect(body.meta.tag[0].code).toBe("demo-local-store");
    expect(mocks.snapshot).toHaveBeenCalledWith({}, expect.any(Buffer), DEMO_USER_ID);
  });
});
