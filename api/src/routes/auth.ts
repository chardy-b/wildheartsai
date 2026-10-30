import { Hono } from "hono";
import { authFor } from "../auth";
import type { Bindings } from "../env";

export const authRoutes = new Hono<{ Bindings: Bindings }>();

// Better Auth's own endpoints: sign-up, sign-in, sign-out, verification, reset, get-session.
authRoutes.on(["GET", "POST"], "/auth/*", (c) => authFor(c.env).handler(c.req.raw));

// The signed-in person, for the web Worker's server components and actions (they forward the
// browser's cookie). Doesn't renew the session: page renders can't set cookies, so the browser's
// own /api/auth/get-session check renews it. Never returns the session token.
// Phase 6 adds demo workspace selection here (src/lib/application-session.ts in the Next app).
authRoutes.get("/session", async (c) => {
  const found = await authFor(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
  c.header("Cache-Control", "no-store");
  if (!found) return c.json({ error: "unauthenticated" }, 401);
  const { user, session } = found;
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified, image: user.image ?? null, createdAt: user.createdAt },
    session: { id: session.id, userId: session.userId, expiresAt: session.expiresAt, createdAt: session.createdAt },
  });
});
