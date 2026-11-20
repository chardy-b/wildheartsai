import { beforeEach, describe, expect, it, vi } from "vitest";

// The Cloudflare backend (src/lib/backend/api.ts) against a fake API service binding: what it
// forwards, and how it reads the answers back into the shapes pages use.
const state = vi.hoisted(() => ({ requests: [] as Request[], respond: (() => new Response(null, { status: 500 })) as (request: Request) => Response }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { API: { fetch: async (request: Request) => (state.requests.push(request), state.respond(request)) } } }),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "better-auth.session_token=made-up", "cf-connecting-ip": "203.0.113.9", authorization: "Bearer must-not-forward", "user-agent": "test" }),
}));

import { apiBackend } from "./api";

const json = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  state.requests = [];
});

describe("apiBackend", () => {
  it("forwards only the cookie, the client IP and the user agent", async () => {
    state.respond = () => json({ sources: [] });
    await apiBackend.sources("ignored");
    const [request] = state.requests;
    expect(new URL(request.url).pathname).toBe("/api/sources");
    expect(request.headers.get("cookie")).toBe("better-auth.session_token=made-up");
    expect(request.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(request.headers.get("authorization")).toBeNull();
  });

  it("reads a signed-out answer as no session, and dates as Dates", async () => {
    state.respond = () => json({ error: "unauthenticated" }, 401);
    expect(await apiBackend.session(new Headers())).toBeNull();
    state.respond = () => json({ user: { id: "u", email: "u@example.test", name: "U", emailVerified: true }, session: { id: "s", userId: "u", expiresAt: "2027-01-01T00:00:00.000Z" } });
    expect((await apiBackend.session(new Headers()))?.session.expiresAt).toEqual(new Date("2027-01-01T00:00:00.000Z"));
    state.respond = () => json({ sources: [{ id: "a", lastSyncedAt: "2026-11-01T00:00:00.000Z" }, { id: "b", lastSyncedAt: null }] });
    expect((await apiBackend.sources("u")).map((s) => s.lastSyncedAt)).toEqual([new Date("2026-11-01T00:00:00.000Z"), null]);
  });

  it("asks for a timeline page with the filters' query string and reads the cursor back", async () => {
    const id = "0b2c4b6a-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
    state.respond = () => json({ sources: [], items: [], related: [], problems: [], next: `2026-01-02T00:00:00.000Z_${id}` });
    const view = await apiBackend.timeline("u", { sourceIds: [id], categories: ["lab"], from: "2026-01-01", to: null }, { at: null, id });
    const url = new URL(state.requests[0].url);
    expect(url.pathname).toBe("/api/records");
    expect(url.searchParams.getAll("org")).toEqual([id]);
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("before")).toBe(`undated_${id}`);
    expect(view.next).toEqual({ at: new Date("2026-01-02T00:00:00.000Z"), id });
  });

  it("turns action outcomes into the same redirects as before", async () => {
    state.respond = () => json({ outcome: "queued" });
    expect(await apiBackend.connectMetriport("u", "jane")).toBe("/app/connections?connected=1");
    expect(await state.requests[0].json()).toEqual({ persona: "jane" });
    state.respond = () => json({ outcome: "unavailable" }, 400);
    expect(await apiBackend.connectMetriport("u", "nobody")).toBe("/app/connections?error=unavailable");
    state.respond = () => json({ outcome: "cooldown" });
    expect(await apiBackend.refresh("u", "a/b")).toBe("cooldown");
    expect(new URL(state.requests.at(-1)!.url).pathname).toBe("/api/sources/a%2Fb/refresh");
  });

  it("collects every page of ready documents, and reads FHIR refusals as messages", async () => {
    const file = (id: string, status = "ready") => ({ id, name: `${id}.pdf`, type: "application/pdf", sizeBytes: 1, uploadedAt: "2026-11-01T00:00:00.000Z", status });
    state.respond = (request) => {
      const page = Number(new URL(request.url).searchParams.get("page"));
      return json({ files: page === 1 ? [file("a"), file("b", "pending")] : [file("c")], usage: { count: 51, bytes: 2 }, page });
    };
    expect((await apiBackend.readyDocuments("u")).map((f) => f.id)).toEqual(["a", "c"]);
    expect(state.requests.map((r) => new URL(r.url).searchParams.get("page"))).toEqual(["1", "2"]);
    state.respond = () => json({ error: "This extraction does not match the original file." }, 409);
    expect(await apiBackend.documentFhir("u", "f", "r")).toEqual({ error: "This extraction does not match the original file." });
    expect(new URL(state.requests.at(-1)!.url).search).toBe("?runId=r");
    state.respond = () => json({ error: "not_found" }, 404);
    expect(await apiBackend.documentFhir("u", "f")).toBeNull();
  });

  it("asks for the real login separately from the selected workspace, and opens the demo through the API", async () => {
    state.respond = () => json({ error: "unauthenticated" }, 401);
    await apiBackend.session(new Headers());
    await apiBackend.realSession(new Headers());
    expect(state.requests.map((r) => new URL(r.url).pathname + new URL(r.url).search)).toEqual(["/api/session", "/api/session?real=1"]);
    state.respond = () => json({ ok: true });
    await apiBackend.openDemoWorkspace({ user: { id: "u", email: "u@example.test", name: "U", emailVerified: true }, session: { id: "s", userId: "u", expiresAt: new Date() } });
    expect([state.requests.at(-1)!.method, new URL(state.requests.at(-1)!.url).pathname]).toEqual(["POST", "/api/demo/workspace"]);
    state.respond = () => json({ error: "Return to the demo entry page and open the guided demo again." }, 409);
    expect(await apiBackend.demoSnapshot("u")).toBeNull();
  });

  it("starts guest demo views through the API, and reads who is viewing the demo", async () => {
    state.respond = () => json({ cookie: "made-up.1795000000000.sig", expiresAt: "2026-11-21T00:00:00.000Z" }, 201);
    expect(await apiBackend.openGuestDemo()).toEqual({ cookie: "made-up.1795000000000.sig", expiresAt: new Date("2026-11-21T00:00:00.000Z") });
    expect([state.requests[0].method, new URL(state.requests[0].url).pathname]).toEqual(["POST", "/api/demo/guest"]);
    state.respond = () => json({ user: { id: "wildhearts_demo_patient_v1", email: "e", name: "n", emailVerified: true }, session: { id: "demo_view_x", userId: "wildhearts_demo_patient_v1", expiresAt: "2026-11-21T00:00:00.000Z" }, demo: { viewer: "guest" } });
    expect((await apiBackend.session(new Headers()))?.demo).toEqual({ viewer: "guest" });
  });

  it("fails loudly on other API errors", async () => {
    state.respond = () => json({ error: "internal_error" }, 500);
    await expect(apiBackend.sources("u")).rejects.toThrow("API responded 500");
  });
});
