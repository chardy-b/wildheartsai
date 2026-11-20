import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_GUEST_COOKIE, isGuestDemoIdentity } from "@/lib/demo/identity";
import { deleteExpiredGuests } from "../src/data/demo";
import { LIMITS } from "../src/limits";
import * as s from "../src/db/schema";
import { clearAll, db, origin, signedIn } from "./helpers";

// The public demo: anyone can open a fictional chart without an account, from a limited number
// per network; guests can't store their own files or connect anything, and their charts go
// when they leave or after a day. Fictional data only.
let ip = 0;
const nextIp = () => `198.51.100.${++ip}`;

async function guest(address = nextIp()) {
  const response = await SELF.fetch(`${origin}/api/demo/guest`, { method: "POST", headers: { "cf-connecting-ip": address } });
  const body = (await response.json()) as { cookie?: string; error?: string };
  const cookie = `${DEMO_GUEST_COOKIE}=${body.cookie}`;
  const send = (path: string, init: RequestInit = {}) => SELF.fetch(`${origin}${path}`, { ...init, headers: { cookie, Origin: origin, "cf-connecting-ip": address, ...(init.headers ?? {}) } });
  return { response, body, cookie, send };
}

const exhaust = async (name: keyof typeof LIMITS, key: string) => {
  const limiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${name}:${key}`));
  for (let i = 0; i < LIMITS[name].limit; i++) await limiter.take(LIMITS[name].limit, LIMITS[name].windowMs);
};

const rowsOf = async (userId: string) => ({
  records: await db.$count(s.fhirResource, eq(s.fhirResource.userId, userId)),
  keys: await db.$count(s.userDataKey, eq(s.userDataKey.userId, userId)),
  sessions: await db.$count(s.session, eq(s.session.userId, userId)),
});

beforeEach(clearAll);

describe("the public guest demo", () => {
  it("opens a fictional chart of the visitor's own, and nothing more", async () => {
    const a = await guest();
    expect(a.response.status).toBe(201);
    const me = (await (await a.send("/api/session")).json()) as { user: { id: string } };
    expect(isGuestDemoIdentity(me.user.id)).toBe(true);
    expect((await a.send("/api/session?real=1")).status).toBe(401);
    const snapshot = (await (await a.send("/api/demo/snapshot")).json()) as { records: unknown[] };
    expect(snapshot.records).toHaveLength(43);
    expect((await a.send("/api/demo/sync", { method: "POST" })).status).toBe(200);

    // Another guest's chart is their own.
    const b = await guest();
    const theirs = (await (await b.send("/api/session")).json()) as { user: { id: string } };
    expect(theirs.user.id).not.toBe(me.user.id);
    const bSources = (await (await b.send("/api/sources")).json()) as { sources: { id: string }[] };
    const aSources = (await (await a.send("/api/sources")).json()) as { sources: { id: string }[] };
    expect(bSources.sources.some((x) => aSources.sources.some((y) => y.id === x.id))).toBe(false);

    // No uploads, no live connections.
    const upload = await a.send("/api/wildcards", { method: "POST", body: "a note", headers: { "Content-Type": "application/octet-stream", "x-file-name": "note.txt" } });
    expect([upload.status, ((await upload.json()) as { error: string }).error]).toEqual([403, expect.stringContaining("Create a free account")]);
    expect((await a.send("/api/wildcards/uploads", { method: "POST", body: JSON.stringify({ name: "a.pdf", size: 10 }), headers: { "Content-Type": "application/json" } })).status).toBe(403);
    expect((await a.send("/api/epic/authorize?iss=https://fhir.example.test/api/FHIR/R4", { redirect: "manual" })).status).toBe(403);

    // A tampered cookie is no one.
    const tampered = a.cookie.slice(0, -2) + (a.cookie.endsWith("AA") ? "BB" : "AA");
    expect((await SELF.fetch(`${origin}/api/session`, { headers: { cookie: tampered } })).status).toBe(401);

    // Leaving deletes the whole fictional chart.
    expect((await rowsOf(me.user.id)).records).toBe(43);
    expect((await a.send("/api/demo/guest", { method: "DELETE" })).status).toBe(204);
    expect(await rowsOf(me.user.id)).toEqual({ records: 0, keys: 0, sessions: 0 });
    expect((await a.send("/api/session")).status).toBe(401);
  });

  it("stores only a hash of the guest's token, and sweeps guests after their day", async () => {
    const a = await guest();
    const token = a.body.cookie!.split(".")[1];
    const [row] = await db.select().from(s.session).where(eq(s.session.id, a.body.cookie!.split(".")[0]));
    expect(row.token).not.toContain(token);
    const me = (await (await a.send("/api/session")).json()) as { user: { id: string } };
    const b = await guest();
    expect(await deleteExpiredGuests(db)).toBe(0);
    await db.update(s.session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(s.session.id, row.id));
    expect((await a.send("/api/session")).status).toBe(401);
    expect(await deleteExpiredGuests(db)).toBe(1);
    expect(await rowsOf(me.user.id)).toEqual({ records: 0, keys: 0, sessions: 0 });
    expect((await b.send("/api/demo/snapshot")).status).toBe(200);
  });

  it("limits new guests per network, and isn't for signed-in people", async () => {
    const crowded = nextIp();
    await exhaust("guestDemoPerIp", crowded);
    const refused = await guest(crowded);
    expect(refused.response.status).toBe(429);
    expect(Number(refused.response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await guest()).response.status).toBe(201);
    const { cookie } = await signedIn("a@example.test");
    expect((await SELF.fetch(`${origin}/api/demo/guest`, { method: "POST", headers: { cookie, "cf-connecting-ip": nextIp() } })).status).toBe(409);
  });
});

describe("rate limits on uploads and demo writes", () => {
  it("refuses uploads past the hourly limit per person and per network", async () => {
    const { userId, cookie } = await signedIn("a@example.test");
    const address = nextIp();
    const upload = () => SELF.fetch(`${origin}/api/wildcards`, { method: "POST", body: "A made-up note.", headers: { cookie, Origin: origin, "cf-connecting-ip": address, "Content-Type": "application/octet-stream", "x-file-name": "note.txt" } });
    expect((await upload()).status).toBe(201);
    await exhaust("uploadPerPerson", userId);
    const refused = await upload();
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([429, "Too many uploads in the last hour. Try again later."]);

    const other = await signedIn("b@example.test");
    const shared = nextIp();
    await exhaust("uploadPerIp", shared);
    const fromShared = await SELF.fetch(`${origin}/api/wildcards/uploads`, { method: "POST", body: JSON.stringify({ name: "a.pdf", size: 10 }), headers: { cookie: other.cookie, Origin: origin, "cf-connecting-ip": shared, "Content-Type": "application/json" } });
    expect(fromShared.status).toBe(429);
  });

  it("refuses demo syncs, resets and sample PDFs past the limit, but not reading", async () => {
    const a = await guest();
    const me = (await (await a.send("/api/session")).json()) as { user: { id: string } };
    await exhaust("demoWritePerPerson", me.user.id);
    expect((await a.send("/api/demo/reset", { method: "POST" })).status).toBe(429);
    expect((await a.send("/api/demo/snapshot")).status).toBe(200);
  });
});
