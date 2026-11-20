import type { Context, MiddlewareHandler } from "hono";
import { DEMO_GUEST_COOKIE, DEMO_MODE_COOKIE, demoSelected, isDemoIdentity, isGuestDemoIdentity } from "@/lib/demo/identity";
import { authFor } from "./auth";
import { guestDemoSession, selectedDemoSession } from "./data/demo";
import { forUser, type UserScope } from "./data/scope";
import { database } from "./db";
import type { Bindings } from "./env";

// The signed-in person for API routes: their id and a scope over only their rows. Reads the
// session without renewing it (the browser's own get-session check renews it).
export type AppEnv = { Bindings: Bindings; Variables: { userId: string; scope: UserScope } };

// The real login, never a demo workspace.
export const realSession = (env: Bindings, headers: Headers) => authFor(env).api.getSession({ headers, query: { disableRefresh: true } });

// The person a request acts as (src/lib/application-session.ts in the Next app). Auth always
// checks the real login first; the demo cookie, bound to that login's session, only selects its
// workspace. A missing or revoked workspace answers signed out, never the personal records.
// Without a login, a guest demo cookie is the visitor's own fictional workspace.
export async function applicationSession(env: Bindings, headers: Headers) {
  const identity = await realSession(env, headers);
  if (!identity) return guestDemoSession(database(env.DB), cookieValue(headers, DEMO_GUEST_COOKIE));
  if (!headers.get("cookie")?.includes(`${DEMO_MODE_COOKIE}=`) || !demoSelected(headers, identity.session.id)) return identity;
  return selectedDemoSession(database(env.DB), identity);
}

export function cookieValue(headers: Headers, name: string): string | undefined {
  return headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

// `whenSignedOut`: redirect to sign-in (browser navigations), answer 401, or answer 401 with a
// message the page shows (Documents' upload client displays it).
export function requireUser(whenSignedOut: "json" | "redirect" | { message: string }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const found = await applicationSession(c.env, c.req.raw.headers);
    if (!found) {
      if (whenSignedOut === "redirect") return c.redirect(new URL("/sign-in", c.req.url).toString());
      return c.json({ error: whenSignedOut === "json" ? "unauthenticated" : whenSignedOut.message }, 401, { "Cache-Control": "no-store" });
    }
    c.set("userId", found.user.id);
    c.set("scope", forUser(database(c.env.DB), found.user.id));
    await next();
  };
}

// Demo workspaces hold fictional records only: no live health-system connections. Checks the
// identity itself, whatever DEMO_ENABLED says. After requireUser.
export function notInDemo(refuse: (c: Context<AppEnv>) => Response): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isDemoIdentity(c.get("userId"))) return refuse(c);
    await next();
  };
}

// Guests may look around, but not store their own files (no account to keep them in).
export const notGuest = (refuse: (c: Context<AppEnv>) => Response): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (isGuestDemoIdentity(c.get("userId"))) return refuse(c);
  await next();
};
