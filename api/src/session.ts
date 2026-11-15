import type { MiddlewareHandler } from "hono";
import { authFor } from "./auth";
import { forUser, type UserScope } from "./data/scope";
import { database } from "./db";
import type { Bindings } from "./env";

// The signed-in person for API routes: their id and a scope over only their rows. Reads the
// session without renewing it (the browser's own get-session check renews it).
// Phase 6 adds demo workspace selection here (src/lib/application-session.ts in the Next app);
// until then nothing on Cloudflare selects a demo identity.
export type AppEnv = { Bindings: Bindings; Variables: { userId: string; scope: UserScope } };

// `whenSignedOut`: redirect to sign-in (browser navigations), answer 401, or answer 401 with a
// message the page shows (Documents' upload client displays it).
export function requireUser(whenSignedOut: "json" | "redirect" | { message: string }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const found = await authFor(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!found) {
      if (whenSignedOut === "redirect") return c.redirect(new URL("/sign-in", c.req.url).toString());
      return c.json({ error: whenSignedOut === "json" ? "unauthenticated" : whenSignedOut.message }, 401, { "Cache-Control": "no-store" });
    }
    c.set("userId", found.user.id);
    c.set("scope", forUser(database(c.env.DB), found.user.id));
    await next();
  };
}
