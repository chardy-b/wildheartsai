import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_MODE_COOKIE, demoModeValue, demoUserId } from "@/lib/demo/identity";
import { buildDemoScenario } from "@/lib/demo/scenario";
import { demoSnapshot, ensureDemoWorkspace, populateDemo, selectedDemoSession } from "../src/data/demo";
import * as s from "../src/db/schema";
import type { Bindings } from "../src/env";
import { clearAll, db, origin, recordsKey, signedIn } from "./helpers";

// The guided demo on Workers: each person's fictional workspace, selected by a cookie bound to
// their own login, and never a way into anyone's real records. Fictional data only.
const bindings = env as unknown as Bindings;

async function login(email: string) {
  const { userId, cookie } = await signedIn(email);
  const real = (await (await SELF.fetch(`${origin}/api/session?real=1`, { headers: { cookie } })).json()) as { session: { id: string; expiresAt: string } };
  const demoCookie = `${cookie}; ${DEMO_MODE_COOKIE}=${demoModeValue(real.session.id)}`;
  const send = (path: string, init: RequestInit & { demo?: boolean } = {}) =>
    SELF.fetch(`${origin}${path}`, { ...init, headers: { cookie: init.demo === false ? cookie : demoCookie, Origin: origin, ...(init.headers ?? {}) } });
  const snapshot = async () => (await (await send("/api/demo/snapshot")).json()) as { sources: { name: string }[]; records: { id: string; fhirId: string; resource: unknown }[] };
  const identity = { user: { id: userId, emailVerified: true }, session: { id: real.session.id, expiresAt: new Date(real.session.expiresAt) } };
  return { userId, cookie, sessionId: real.session.id, demoCookie, send, snapshot, identity };
}

beforeEach(clearAll);

describe("the guided demo on Workers", () => {
  it("gives each person an isolated fictional chart that the demo cookie selects, without touching their own", async () => {
    const a = await login("a@example.test");
    const b = await login("b@example.test");
    await db.insert(s.healthSource).values({ userId: a.userId, vendor: "epic", fhirBaseUrl: "https://private.example/FHIR/R4", organizationName: "Personal chart", status: "disconnected" });
    expect((await a.send("/api/demo/workspace", { method: "POST", demo: false })).status).toBe(200);
    expect((await b.send("/api/demo/workspace", { method: "POST", demo: false })).status).toBe(200);

    const selected = (await (await a.send("/api/session")).json()) as { user: { id: string }; session: { id: string } };
    expect(selected.user.id).toBe(demoUserId(a.userId));
    expect(selected.session.id).not.toBe(a.sessionId);
    expect(((await (await a.send("/api/session?real=1")).json()) as { user: { id: string } }).user.id).toBe(a.userId);
    expect(await db.select().from(s.account).where(eq(s.account.userId, selected.user.id))).toEqual([]);

    const before = await a.snapshot();
    expect(before.sources).toHaveLength(3);
    expect(before.records).toHaveLength(43);
    // The rest of the API sees the workspace too, and only it.
    const sources = (await (await a.send("/api/sources")).json()) as { sources: { organizationName: string }[] };
    expect(sources.sources.map((x) => x.organizationName).every((name) => name.endsWith("· fictional demo"))).toBe(true);
    const personal = (await (await a.send("/api/sources", { demo: false })).json()) as { sources: { organizationName: string }[] };
    expect(personal.sources.map((x) => x.organizationName)).toEqual(["Personal chart"]);

    // Reopening doesn't duplicate anything.
    await a.send("/api/demo/workspace", { method: "POST", demo: false });
    expect((await a.snapshot()).records.map((r) => r.id).sort()).toEqual(before.records.map((r) => r.id).sort());

    // The sample PDF's records, added once however often it's sent.
    const pdf = await (await a.send("/api/demo/sample.pdf")).arrayBuffer();
    for (let i = 0; i < 2; i++) expect((await a.send("/api/demo/document", { method: "POST", body: pdf })).status).toBe(200);
    const withDocument = await a.snapshot();
    expect(withDocument.sources).toHaveLength(4);
    expect(withDocument.records.filter((r) => r.fhirId === "outside-ferritin")).toHaveLength(1);
    expect(JSON.stringify(withDocument.records.find((r) => r.fhirId === "outside-ferritin")?.resource)).toContain("DocumentReference/outside-report");
    expect((await a.send("/api/demo/document", { method: "POST", body: "%PDF-1.4 something else" })).status).toBe(422);

    // Reset clears only this workspace's fictional sources.
    expect((await a.send("/api/demo/reset", { method: "POST" })).status).toBe(200);
    expect((await a.snapshot()).records.some((r) => r.fhirId === "outside-report")).toBe(false);
    expect((await b.snapshot()).records).toHaveLength(43);
    expect(await db.select({ name: s.healthSource.organizationName }).from(s.healthSource).where(eq(s.healthSource.userId, a.userId))).toEqual([{ name: "Personal chart" }]);

    // Stored encrypted, like any record.
    const stored = await db.select().from(s.fhirResource).where(eq(s.fhirResource.userId, selected.user.id));
    expect(stored.every((r) => !r.sealedResource.includes("Alex") && !r.sealedSummary.includes("esophagitis"))).toBe(true);
  });

  it("refuses live connections, cross-site writes, and the demo API outside a workspace", async () => {
    const a = await login("a@example.test");
    await a.send("/api/demo/workspace", { method: "POST", demo: false });
    const authorize = await a.send("/api/epic/authorize?iss=https://fhir.example.test/api/FHIR/R4", { redirect: "manual" });
    expect(authorize.status).toBe(403);
    const metriport = await a.send("/api/connections/metriport", { method: "POST", body: JSON.stringify({ persona: "jane" }), headers: { "Content-Type": "application/json" } });
    expect([metriport.status, await metriport.json()]).toEqual([400, { outcome: "unavailable" }]);
    const crossSite = await SELF.fetch(`${origin}/api/demo/sync`, { method: "POST", headers: { cookie: a.demoCookie, Origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);
    // A real login without the cookie, or with someone else's value, isn't in the demo.
    expect((await a.send("/api/demo/snapshot", { demo: false })).status).toBe(404);
    const b = await login("b@example.test");
    const borrowed = await SELF.fetch(`${origin}/api/demo/snapshot`, { headers: { cookie: `${b.cookie}; ${DEMO_MODE_COOKIE}=${demoModeValue(a.sessionId)}` } });
    expect(borrowed.status).toBe(404);
    expect((await SELF.fetch(`${origin}/api/demo/snapshot`)).status).toBe(401);
  });

  it("ends the workspace with the login: expiry, then sign-out deletes it", async () => {
    const a = await login("a@example.test");
    await a.send("/api/demo/workspace", { method: "POST", demo: false });
    const selected = (await selectedDemoSession(db, a.identity))!;
    expect(selected.session.parentSessionId).toBe(a.sessionId);
    // Someone else's login can't select it.
    const b = await login("b@example.test");
    expect(await selectedDemoSession(db, { ...b.identity, session: a.identity.session })).toBeNull();

    const signOut = await SELF.fetch(`${origin}/api/auth/sign-out`, { method: "POST", headers: { cookie: a.cookie, Origin: origin } });
    expect(signOut.status).toBe(200);
    expect((await a.send("/api/session")).status).toBe(401);
    expect(await db.select().from(s.session).where(eq(s.session.id, selected.session.id))).toEqual([]);

    const again = await login("c@example.test");
    await again.send("/api/demo/workspace", { method: "POST", demo: false });
    await db.update(s.session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(s.session.id, again.sessionId));
    expect(await selectedDemoSession(db, again.identity)).toBeNull();
  });

  it("requires a verified, current real login, refuses nested workspaces and non-demo identities", async () => {
    const a = await login("a@example.test");
    await expect(ensureDemoWorkspace(bindings, db, recordsKey, { ...a.identity, user: { id: a.userId, emailVerified: false } })).rejects.toThrow("demo_login_required");
    await db.update(s.user).set({ emailVerified: false }).where(eq(s.user.id, a.userId));
    await expect(ensureDemoWorkspace(bindings, db, recordsKey, a.identity)).rejects.toThrow("demo_login_required");
    await db.update(s.user).set({ emailVerified: true }).where(eq(s.user.id, a.userId));
    await ensureDemoWorkspace(bindings, db, recordsKey, a.identity);
    const selected = (await selectedDemoSession(db, a.identity))!;
    await expect(ensureDemoWorkspace(bindings, db, recordsKey, selected)).rejects.toThrow("demo_login_required");
    await expect(demoSnapshot(db, recordsKey, a.userId)).rejects.toThrow("demo_forbidden");
    expect(() => populateDemo(bindings, db, recordsKey, a.userId)).toThrow("demo_forbidden");
    // The anchor stays the day the chart was first made, so a re-sync keeps every record.
    const first = (await demoSnapshot(db, recordsKey, selected.user.id))!;
    expect(first.records).toHaveLength(buildDemoScenario(first.anchor).length);
    await populateDemo(bindings, db, recordsKey, selected.user.id, { now: new Date(Date.now() + 40 * 86400_000) });
    const second = (await demoSnapshot(db, recordsKey, selected.user.id))!;
    expect([second.anchor, second.records.map((r) => r.id).sort()]).toEqual([first.anchor, first.records.map((r) => r.id).sort()]);
  });
});
