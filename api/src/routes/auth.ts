import { Hono } from "hono";
import { authFor } from "../auth";
import { secrets, type Bindings } from "../env";
import { applicationSession, realSession } from "../session";

export const authRoutes = new Hono<{ Bindings: Bindings }>();

// Better Auth's own endpoints: sign-up, sign-in, sign-out, verification, reset, get-session.
authRoutes.on(["GET", "POST"], "/auth/*", (c) => authFor(c.env).handler(c.req.raw));

// What the sign-up page shows: whether sign-ups are open, and whether they need an invite code
// (never the code). Public, like the page.
authRoutes.get("/signup-settings", (c) => {
  const config = secrets(c.env);
  return c.json({ signupsEnabled: config.SIGNUPS_ENABLED, inviteRequired: Boolean(config.SIGNUP_INVITE_CODE) }, 200, { "Cache-Control": "no-store" });
});

// The signed-in person, for the web Worker's server components and actions (they forward the
// browser's cookie). Doesn't renew the session: page renders can't set cookies, so the browser's
// own /api/auth/get-session check renews it. Never returns the session token.
// The demo chart (with `demo`: who is viewing) when the browser is viewing the demo; `?real=1`
// for the login itself.
authRoutes.get("/session", async (c) => {
  const headers = c.req.raw.headers;
  const found = c.req.query("real") === "1" ? await realSession(c.env, headers) : await applicationSession(c.env, headers);
  c.header("Cache-Control", "no-store");
  if (!found) return c.json({ error: "unauthenticated" }, 401);
  const { user, session } = found;
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified, image: user.image ?? null, createdAt: user.createdAt },
    session: { id: session.id, userId: session.userId, expiresAt: session.expiresAt, createdAt: session.createdAt },
    ...("demo" in found ? { demo: { viewer: found.demo.viewer } } : {}),
  });
});
