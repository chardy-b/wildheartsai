import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { user } from "@/lib/db/schema";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));

import { createAuth } from "@/lib/auth";

afterEach(() => vi.useRealTimers());

it("keeps a remembered browser signed in across days and renews its cookie with the database session", async () => {
  const db = await createTestDb();
  state.db = db;
  const auth = createAuth();
  const email = "remembered-browser@example.com";
  const password = "synthetic-test-password";
  await auth.api.signUpEmail({ body: { email, password, name: "Test Person" } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));

  const origin = "http://localhost:3000";
  const signIn = await auth.handler(new Request(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email, password, rememberMe: true }),
  }));
  expect(signIn.status).toBe(200);
  const cookieHeader = signIn.headers.getSetCookie().find((cookie) => cookie.startsWith("better-auth.session_token="));
  expect(cookieHeader).toContain("Max-Age=7776000");
  expect(cookieHeader).toContain("HttpOnly");
  const cookie = cookieHeader!.split(";")[0];
  const started = Date.now();
  // Keep real I/O timers running while advancing the authentication clock.
  vi.useFakeTimers({ toFake: ["Date"] });

  for (const days of [2, 8, 89, 100]) {
    vi.setSystemTime(started + days * 86400_000);
    const pageSession = await auth.api.getSession({ headers: new Headers({ cookie }), query: { disableRefresh: true } });
    expect(pageSession?.user.email).toBe(email);
    const renewed = await auth.handler(new Request(`${origin}/api/auth/get-session`, { headers: { cookie } }));
    expect(renewed.status).toBe(200);
    const body = await renewed.json();
    expect(body?.user.email).toBe(email);
    expect(new Date(body.session.expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 86400_000);
    expect(renewed.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))).toContain("Max-Age=7776000");
  }

  const signedOut = await auth.handler(new Request(`${origin}/api/auth/sign-out`, {
    method: "POST", headers: { cookie, Origin: origin },
  }));
  expect(signedOut.status).toBe(200);
  expect(await auth.api.getSession({ headers: new Headers({ cookie }), query: { disableRefresh: true } })).toBeNull();
});
