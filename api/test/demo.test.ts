import { env, SELF } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_GUEST_COOKIE, DEMO_MODE_COOKIE, demoModeValue } from "@/lib/demo/identity";
import { buildDemoScenario, DEMO_USER_ID } from "@/lib/demo/scenario";
import { guestViewer, issueGuestViewer } from "../src/data/demo";
import * as s from "../src/db/schema";
import { clearAll, db, origin, signedIn } from "./helpers";

// The guided demo on Workers: one central fictional chart that everyone views, and nothing
// written for any visitor. Fictional data only.
const secret = env.BETTER_AUTH_SECRET!;

// Every row in the main database, by table: a visit must leave these unchanged.
async function footprint() {
  const tables = (await db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' and name != 'd1_migrations'`)).map((t) => t.name);
  const counts: Record<string, number> = {};
  for (const name of tables) counts[name] = (await db.all<{ n: number }>(sql.raw(`select count(*) as n from "${name}"`)))[0].n;
  return counts;
}

async function guest() {
  const response = await SELF.fetch(`${origin}/api/demo/guest`, { method: "POST", headers: { "cf-connecting-ip": "198.51.100.7" } });
  const body = (await response.json()) as { cookie: string };
  const cookie = `${DEMO_GUEST_COOKIE}=${body.cookie}`;
  const send = (path: string, init: RequestInit = {}) => SELF.fetch(`${origin}${path}`, { ...init, headers: { cookie, Origin: origin, ...(init.headers ?? {}) } });
  return { response, body, cookie, send };
}

async function member(email: string) {
  const { userId, cookie } = await signedIn(email);
  const real = (await (await SELF.fetch(`${origin}/api/session?real=1`, { headers: { cookie } })).json()) as { session: { id: string } };
  const demoCookie = `${cookie}; ${DEMO_MODE_COOKIE}=${demoModeValue(real.session.id)}`;
  const send = (path: string, init: RequestInit & { demo?: boolean } = {}) =>
    SELF.fetch(`${origin}${path}`, { ...init, headers: { cookie: init.demo === false ? cookie : demoCookie, Origin: origin, ...(init.headers ?? {}) } });
  return { userId, cookie, send };
}

type Snapshot = { sources: { name: string }[]; records: { id: string; fhirId: string; resource: unknown }[] };

beforeEach(clearAll);

describe("the demo on rails", () => {
  it("writes the central chart once, then lets any number of visitors through it without writing anything", async () => {
    const first = await guest();
    expect(first.response.status).toBe(201);
    const before = await footprint();
    expect(before.user).toBe(1);
    expect(before.fhir_resource).toBe(buildDemoScenario("2026-01-01").length + 2);

    const visitors = [first, await guest(), await guest()];
    const pdf = await (await first.send("/api/demo/sample.pdf")).arrayBuffer();
    for (const visitor of visitors) {
      const me = (await (await visitor.send("/api/session")).json()) as { user: { id: string }; demo: { viewer: string } };
      expect(me).toMatchObject({ user: { id: DEMO_USER_ID }, demo: { viewer: "guest" } });
      const shown = (await (await visitor.send("/api/demo/snapshot")).json()) as Snapshot;
      expect([shown.sources.length, shown.records.length]).toEqual([3, 43]);
      // Each step of the walkthrough answers from the chart.
      expect(((await (await visitor.send("/api/demo/sync", { method: "POST" })).json()) as Snapshot).records).toHaveLength(43);
      const withPdf = (await (await visitor.send("/api/demo/document", { method: "POST", body: pdf })).json()) as Snapshot;
      expect(withPdf.sources).toHaveLength(4);
      expect(withPdf.records.filter((r) => r.fhirId === "outside-ferritin")).toHaveLength(1);
      expect(((await (await visitor.send("/api/demo/sync?document=1", { method: "POST" })).json()) as Snapshot).records).toHaveLength(45);
      expect(((await (await visitor.send("/api/demo/reset", { method: "POST" })).json()) as Snapshot).records).toHaveLength(43);
      expect((await visitor.send("/api/demo/document", { method: "POST", body: "%PDF-1.4 something else" })).status).toBe(422);
      // The rest of the app reads the same chart.
      expect((await visitor.send("/api/records")).status).toBe(200);
      expect((await visitor.send("/api/export")).status).toBe(200);
    }
    expect(await footprint()).toEqual(before);
  });

  it("refuses every write a demo viewer tries, so the shared chart can't change", async () => {
    const g = await guest();
    const m = await member("a@example.test");
    const before = await footprint();
    const [source] = await db.select().from(s.healthSource).where(eq(s.healthSource.userId, DEMO_USER_ID));
    for (const viewer of [g, m]) {
      const attempts = [
        viewer.send("/api/wildcards", { method: "POST", body: "a note", headers: { "Content-Type": "application/octet-stream", "x-file-name": "note.txt" } }),
        viewer.send("/api/wildcards/uploads", { method: "POST", body: JSON.stringify({ name: "a.pdf", size: 10 }), headers: { "Content-Type": "application/json" } }),
        viewer.send(`/api/sources/${source.id}`, { method: "DELETE" }),
        viewer.send(`/api/sources/${source.id}/refresh`, { method: "POST" }),
        viewer.send("/api/profile/name", { method: "POST", body: JSON.stringify({ preferredName: "Changed" }), headers: { "Content-Type": "application/json" } }),
        viewer.send("/api/connections/metriport", { method: "POST", body: JSON.stringify({ persona: "jane" }), headers: { "Content-Type": "application/json" } }),
        viewer.send("/api/extraction", { method: "POST", body: JSON.stringify({ fileIds: [], methods: ["native"] }), headers: { "Content-Type": "application/json" } }),
      ];
      for (const response of await Promise.all(attempts)) {
        expect(response.status).toBe(403);
        expect(((await response.json()) as { error: string }).error).toMatch(/view-only/);
      }
      expect((await viewer.send("/api/epic/authorize?iss=https://fhir.example.test/api/FHIR/R4", { redirect: "manual" })).status).toBe(403);
    }
    expect(await footprint()).toEqual(before);
    // Without the demo cookie, the member is themselves again and can write their own data.
    expect((await m.send("/api/profile/name", { method: "POST", body: JSON.stringify({ preferredName: "Sam" }), headers: { "Content-Type": "application/json" }, demo: false })).status).toBeLessThan(300);
  });

  it("signed-in viewers see the same chart, and their own records stay theirs", async () => {
    const m = await member("a@example.test");
    await db.insert(s.healthSource).values({ userId: m.userId, vendor: "epic", fhirBaseUrl: "https://private.example/FHIR/R4", organizationName: "Personal chart", status: "disconnected" });
    expect((await m.send("/api/demo/workspace", { method: "POST", demo: false })).status).toBe(200);
    const viewing = (await (await m.send("/api/session")).json()) as { user: { id: string }; demo: { viewer: string } };
    expect(viewing).toMatchObject({ user: { id: DEMO_USER_ID }, demo: { viewer: "member" } });
    const demoSources = (await (await m.send("/api/sources")).json()) as { sources: { organizationName: string }[] };
    expect(demoSources.sources.every((x) => x.organizationName.endsWith("· fictional demo"))).toBe(true);
    const own = (await (await m.send("/api/sources", { demo: false })).json()) as { sources: { organizationName: string }[] };
    expect(own.sources.map((x) => x.organizationName)).toEqual(["Personal chart"]);
    // Signing out ends the demo view with the login.
    await SELF.fetch(`${origin}/api/auth/sign-out`, { method: "POST", headers: { cookie: m.cookie, Origin: origin } });
    expect((await m.send("/api/session")).status).toBe(401);
  });

  it("accepts only its own guest cookies, and only for a day", async () => {
    const { cookie } = issueGuestViewer(secret);
    expect(guestViewer(secret, cookie)).not.toBeNull();
    expect(guestViewer("another-secret-that-is-long-enough-000", cookie)).toBeNull();
    const [id, expires, signature] = cookie.split(".");
    expect(guestViewer(secret, `${id}.${Number(expires) + 86_400_000}.${signature}`)).toBeNull();
    expect(guestViewer(secret, cookie, new Date(Number(expires) + 1))).toBeNull();
    expect((await SELF.fetch(`${origin}/api/demo/snapshot`, { headers: { cookie: `${DEMO_GUEST_COOKIE}=${id}.${expires}.${"A".repeat(43)}` } })).status).toBe(401);
    // A signed-in person who isn't viewing the demo isn't let in by the demo routes.
    const m = await member("b@example.test");
    expect((await m.send("/api/demo/snapshot", { demo: false })).status).toBe(404);
    expect((await SELF.fetch(`${origin}/api/demo/guest`, { method: "POST", headers: { cookie: m.cookie } })).status).toBe(409);
  });
});
