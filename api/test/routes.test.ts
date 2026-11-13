import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EPIC_SANDBOX } from "@/lib/epic/directory";
import { FLOW_COOKIE } from "@/lib/epic/flow";
import * as s from "../src/db/schema";
import { clearAll, db, origin, signedIn } from "./helpers";

// The API over HTTP, as the web Worker, the browser and Epic reach it.
const AUTHORIZE = "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize";
const TOKEN = "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token";

const get = (path: string, cookie?: string) => SELF.fetch(`${origin}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
const send = (method: string, path: string, cookie: string, body?: unknown) =>
  SELF.fetch(`${origin}${path}`, { method, headers: { cookie, "Content-Type": "application/json", Origin: origin }, body: body === undefined ? undefined : JSON.stringify(body) });

let tokenRequests = 0;
beforeEach(async () => {
  await clearAll();
  tokenRequests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${EPIC_SANDBOX.fhirBaseUrl}/.well-known/smart-configuration`) {
      return Response.json({ authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN, code_challenge_methods_supported: ["S256"] });
    }
    if (url === TOKEN) {
      tokenRequests++;
      return Response.json({ access_token: "made-up-access", token_type: "Bearer", expires_in: 3600, scope: "openid fhirUser patient/Observation.read", refresh_token: "made-up-refresh", patient: "made-up-patient" });
    }
    return new Response("unexpected", { status: 500 });
  });
});
afterEach(() => vi.restoreAllMocks());

describe("runtime", () => {
  it("accepts the fetch options the shared Epic code uses", () => {
    expect(() => new Request("https://example.test", { cache: "no-store" })).not.toThrow();
  });
});

describe("Epic connection routes", () => {
  it("publishes the sandbox key set, and keeps production's closed", async () => {
    const jwks = (await (await get("/api/epic/jwks")).json()) as { keys: { kid: string; d?: string }[] };
    expect(jwks.keys).toEqual([expect.objectContaining({ kid: "test-run-key", kty: "RSA" })]);
    expect(jwks.keys[0].d).toBeUndefined();
    expect((await get("/api/epic/jwks/production")).status).toBe(404);
  });

  it("sends signed-out people to sign in", async () => {
    const response = await get(`/api/epic/authorize?iss=${encodeURIComponent(EPIC_SANDBOX.fhirBaseUrl)}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${origin}/sign-in`);
  });

  it("connects the sandbox end to end: authorize, callback, stored tokens, queued import", async () => {
    const { userId, cookie } = await signedIn("connect@example.test");
    const authorize = await get(`/api/epic/authorize?iss=${encodeURIComponent(EPIC_SANDBOX.fhirBaseUrl)}`, cookie);
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe(AUTHORIZE);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("aud")).toBe(EPIC_SANDBOX.fhirBaseUrl);
    const flowHeader = authorize.headers.getSetCookie().find((c) => c.startsWith(`${FLOW_COOKIE}=`))!;
    expect(flowHeader).toMatch(/HttpOnly/i);
    expect(flowHeader).toMatch(/Path=\/api\/epic/);
    const flow = flowHeader.split(";")[0];

    // A forged state is refused before any token request.
    const forged = await get("/api/epic/callback?code=c&state=forged", `${cookie}; ${flow}`);
    expect(forged.headers.get("Location")).toBe(`${origin}/app/connections?error=invalid_state`);
    expect(tokenRequests).toBe(0);

    const callback = await get(`/api/epic/callback?code=made-up-code&state=${location.searchParams.get("state")}`, `${cookie}; ${flow}`);
    expect(callback.headers.get("Location")).toBe(`${origin}/app/connections?connected=1`);
    expect(callback.headers.getSetCookie().some((c) => c.startsWith(`${FLOW_COOKIE}=;`))).toBe(true);
    expect(tokenRequests).toBe(1);

    const [connection] = await db.select().from(s.epicConnection).where(eq(s.epicConnection.userId, userId));
    expect(connection.sealedAccessToken).not.toContain("made-up-access");
    const [run] = await db.select().from(s.syncRun).where(eq(s.syncRun.userId, userId));
    expect(run).toMatchObject({ status: "queued", trigger: "connect" });
  });
});

describe("records, connections and onboarding routes", () => {
  it("need a signed-in person", async () => {
    for (const path of ["/api/sources", "/api/records", "/api/records/note?sourceId=x&url=y", "/api/export", "/api/profile", "/api/connections/choices"]) {
      expect((await get(path)).status, path).toBe(401);
    }
    const id = crypto.randomUUID();
    for (const [method, path] of [["POST", `/api/sources/${id}/refresh`], ["POST", "/api/sources/refresh"], ["DELETE", `/api/sources/${id}`], ["POST", `/api/connections/${id}/disconnect`], ["POST", "/api/profile/name"], ["POST", "/api/profile/acknowledge"], ["POST", "/api/profile/complete"]]) {
      expect((await SELF.fetch(`${origin}${path}`, { method, headers: { Origin: origin } })).status, `${method} ${path}`).toBe(401);
    }
  });

  it("walk through onboarding", async () => {
    const { cookie } = await signedIn("onboard@example.test");
    const step = async () => ((await (await get("/api/profile", cookie)).json()) as { step: string }).step;
    expect(await step()).toBe("name");
    expect((await send("POST", "/api/profile/name", cookie, { preferredName: " " })).status).toBe(400);
    await send("POST", "/api/profile/name", cookie, { preferredName: "Sam" });
    expect(await step()).toBe("acknowledge");
    expect((await send("POST", "/api/profile/acknowledge", cookie, { "not-medical-advice": "on" })).status).toBe(400);
    await send("POST", "/api/profile/acknowledge", cookie, { "not-medical-advice": "on", "privacy-notice": "on" });
    expect(await step()).toBe("connect");
    await send("POST", "/api/profile/complete", cookie);
    expect(await step()).toBe("done");
  });

  it("refresh, export, disconnect and delete act only on the person's own sources", async () => {
    const a = await signedIn("a@example.test");
    const b = await signedIn("b@example.test");
    const sourceId = crypto.randomUUID();
    await db.insert(s.healthSource).values({ id: sourceId, userId: a.userId, vendor: "epic", fhirBaseUrl: EPIC_SANDBOX.fhirBaseUrl, organizationName: "Sandbox", status: "connected" });

    expect(await (await send("POST", `/api/sources/${sourceId}/refresh`, b.cookie)).json()).toEqual({ outcome: "not_connected" });
    expect(await (await send("POST", `/api/sources/${sourceId}/refresh`, a.cookie)).json()).toEqual({ outcome: "queued" });
    expect(await (await send("POST", "/api/sources/refresh", a.cookie)).json()).toEqual({ outcome: "already_running" });

    const records = (await (await get("/api/records", a.cookie)).json()) as { sources: { id: string; syncing: boolean }[]; items: unknown[]; next: string | null };
    expect(records.sources).toEqual([expect.objectContaining({ id: sourceId, syncing: true })]);
    expect(records.items).toEqual([]);
    expect(((await (await get("/api/records", b.cookie)).json()) as { sources: unknown[] }).sources).toEqual([]);

    const download = await get("/api/export", a.cookie);
    expect(download.headers.get("Content-Type")).toContain("application/fhir+json");
    expect(download.headers.get("Content-Disposition")).toMatch(/^attachment; filename="wild-hearts-records-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(await download.json()).toMatchObject({ resourceType: "Bundle", type: "collection", entry: [] });

    expect(await (await send("DELETE", `/api/sources/${sourceId}`, b.cookie)).json()).toEqual({ deleted: false });
    expect(await (await send("DELETE", `/api/sources/${sourceId}`, a.cookie)).json()).toEqual({ deleted: true });
    const actions = (await db.select().from(s.auditEvent)).map((e) => `${e.userId === a.userId ? "a" : "b"}:${e.action}`).sort();
    expect(actions).toEqual(["a:delete_source", "a:export"]);
  });

  it("offers the sandbox to connect in sandbox mode", async () => {
    const { cookie } = await signedIn("choices@example.test");
    expect(await (await get("/api/connections/choices?q=", cookie)).json()).toEqual({ choices: { results: [EPIC_SANDBOX], sample: null } });
  });
});
