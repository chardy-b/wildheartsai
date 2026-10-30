import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import type { Email } from "../src/auth/email";
import { database } from "../src/db";
import * as s from "../src/db/schema";
import type { Bindings } from "../src/env";
import nodeHash from "./node-password-fixture.json";

// Ported from src/lib/auth-session.test.ts, plus what changes on Workers: D1 storage, the client IP
// header used for rate limiting, and password hashes made by the Node app.
const origin = "http://localhost:3000";
const password = "made-up-test-password";
const db = database(env.DB);

function setup(overrides: Partial<Bindings> = {}) {
  const sent: Email[] = [];
  const auth = createAuth({ ...env, ...overrides } as Bindings, { sendEmail: async (email) => void sent.push(email) });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    auth.handler(new Request(`${origin}/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, "cf-connecting-ip": "198.51.100.7", ...headers },
      body: JSON.stringify(body),
    }));
  return { auth, sent, post };
}

const sessionCookie = (response: Response) =>
  response.headers.getSetCookie().find((cookie) => cookie.startsWith("better-auth.session_token="));

beforeEach(async () => {
  await db.delete(s.user);
  await db.delete(s.rateLimit);
  await db.delete(s.verification);
});
afterEach(() => vi.useRealTimers());

describe("Better Auth on D1", () => {
  it("signs up, verifies by email, keeps a remembered browser signed in, and signs out", async () => {
    const { auth, sent, post } = setup();
    const email = "remembered@example.test";
    expect((await post("/sign-up/email", { email, password, name: "Test Person" })).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Confirm your email for Wild Hearts Health");

    // Unverified accounts can't sign in.
    expect((await post("/sign-in/email", { email, password })).status).toBe(403);

    const link = sent[0].text.split("\n").find((line) => line.startsWith("http"))!;
    const verified = await auth.handler(new Request(link, { headers: { "cf-connecting-ip": "198.51.100.7" } }));
    expect(verified.status).toBeLessThan(400);

    const signIn = await post("/sign-in/email", { email, password, rememberMe: true });
    expect(signIn.status).toBe(200);
    const header = sessionCookie(signIn)!;
    expect(header).toContain("Max-Age=7776000");
    expect(header).toContain("HttpOnly");
    const cookie = header.split(";")[0];

    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const days of [2, 8, 89, 100]) {
      vi.setSystemTime(started + days * 86400_000);
      const page = await auth.api.getSession({ headers: new Headers({ cookie }), query: { disableRefresh: true } });
      expect(page?.user.email).toBe(email);
      const renewed = await auth.handler(new Request(`${origin}/api/auth/get-session`, { headers: { cookie } }));
      const body = (await renewed.json()) as { session: { expiresAt: string } };
      expect(new Date(body.session.expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 86400_000);
      expect(sessionCookie(renewed)).toContain("Max-Age=7776000");
    }
    vi.useRealTimers();

    expect((await auth.handler(new Request(`${origin}/api/auth/sign-out`, { method: "POST", headers: { cookie, Origin: origin } }))).status).toBe(200);
    expect(await auth.api.getSession({ headers: new Headers({ cookie }), query: { disableRefresh: true } })).toBeNull();
  });

  it("signs in accounts whose password was hashed by the Node app", async () => {
    const { post } = setup();
    const now = new Date();
    await db.insert(s.user).values({ id: "migrated", name: "Migrated", email: "migrated@example.test", emailVerified: true, updatedAt: now });
    await db.insert(s.account).values({ id: "migrated-account", accountId: "migrated", providerId: "credential", userId: "migrated", password: nodeHash.hash, updatedAt: now });
    expect((await post("/sign-in/email", { email: "migrated@example.test", password: nodeHash.password })).status).toBe(200);
    expect((await post("/sign-in/email", { email: "migrated@example.test", password: "not-the-password" })).status).toBe(401);
  });

  it("needs the invite code when one is set", async () => {
    const { post } = setup({ SIGNUP_INVITE_CODE: "made-up-invite" });
    const denied = await post("/sign-up/email", { email: "a@example.test", password, name: "A" });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe("INVITE_CODE_INVALID");
    expect((await post("/sign-up/email", { email: "b@example.test", password, name: "B", inviteCode: " Made-Up-Invite " })).status).toBe(200);
  });

  it("refuses sign-up when sign-ups are off", async () => {
    const { post, sent } = setup({ SIGNUPS_ENABLED: "false" });
    expect((await post("/sign-up/email", { email: "c@example.test", password, name: "C" })).status).toBeGreaterThanOrEqual(400);
    expect(sent).toHaveLength(0);
  });

  it("rate-limits sign-in per client IP from Cloudflare, not a forgeable header", async () => {
    const { post } = setup({ APP_ENV: "preview" });
    const attempt = (ip: string, forwarded = "203.0.113.1") =>
      post("/sign-in/email", { email: "nobody@example.test", password }, { "cf-connecting-ip": ip, "x-forwarded-for": forwarded });
    for (let i = 0; i < 10; i++) expect((await attempt("192.0.2.10", `203.0.113.${i}`)).status).toBe(401);
    // A new X-Forwarded-For value doesn't reset the count; another real client isn't affected.
    expect((await attempt("192.0.2.10", "203.0.113.99")).status).toBe(429);
    expect((await attempt("192.0.2.11")).status).toBe(401);
  });

  it("fails closed when production has no email provider", async () => {
    const logged: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((line: string) => void logged.push(line));
    try {
      const auth = createAuth({ ...env, APP_ENV: "production", EMAIL_LOG_LINKS: "true" } as Bindings);
      const post = (path: string, body: unknown) => auth.handler(new Request(`${origin}/api/auth${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, "cf-connecting-ip": "198.51.100.8" },
        body: JSON.stringify(body),
      }));
      // Better Auth logs a failed email and still answers 200, as on Vercel today. No link is
      // sent or printed, so the account stays unverified and can't sign in.
      expect((await post("/sign-up/email", { email: "d@example.test", password, name: "D" })).status).toBe(200);
      expect(logged.join("\n")).not.toContain("http");
      expect((await post("/sign-in/email", { email: "d@example.test", password })).status).toBe(403);
    } finally {
      info.mockRestore();
    }
  });
});

describe("routes", () => {
  it("serves Better Auth under /api/auth", async () => {
    const response = await SELF.fetch(`${origin}/api/auth/get-session`);
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it("returns the signed-in person to the web Worker, without the session token", async () => {
    expect((await SELF.fetch(`${origin}/api/session`)).status).toBe(401);

    const { auth } = setup();
    await auth.api.signUpEmail({ body: { email: "e@example.test", password, name: "E" } });
    await db.update(s.user).set({ emailVerified: true });
    const signIn = await SELF.fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, "cf-connecting-ip": "198.51.100.9" },
      body: JSON.stringify({ email: "e@example.test", password }),
    });
    const cookie = sessionCookie(signIn)!.split(";")[0];
    const response = await SELF.fetch(`${origin}/api/session`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    const body = JSON.parse(text) as { user: { email: string }; session: Record<string, unknown> };
    expect(body.user.email).toBe("e@example.test");
    expect(Object.keys(body.session).sort()).toEqual(["createdAt", "expiresAt", "id", "userId"]);
    expect(text).not.toContain(cookie.split("=")[1].split(".")[0]);
  });
});
