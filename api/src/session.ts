import type { Context, MiddlewareHandler } from "hono";
import { DEMO_GUEST_COOKIE, DEMO_MODE_COOKIE, demoSelected, isDemoIdentity } from "@/lib/demo/identity";
import { authFor } from "./auth";
import { demoIdentity, guestViewer } from "./data/demo";
import { forUser, type UserScope } from "./data/scope";
import { database } from "./db";
import { secrets, type Bindings } from "./env";

// The signed-in person for API routes: their id and a scope over only their rows. Reads the
// session without renewing it (the browser's own get-session check renews it).
export type AppEnv = { Bindings: Bindings; Variables: { userId: string; scope: UserScope } };

// The real login, never the demo.
export const realSession = (env: Bindings, headers: Headers) => authFor(env).api.getSession({ headers, query: { disableRefresh: true } });

// The identity a request acts as (src/lib/application-session.ts in the Next app). Auth always
// checks the real login first; the demo-mode cookie, bound to that login's session, switches it
// to viewing the demo. Without a login, a valid guest cookie views the demo. Either way the
// identity is the central demo chart's, marked `demo`, and read-only (`demoReadOnly` below).
export async function applicationSession(env: Bindings, headers: Headers) {
  const identity = await realSession(env, headers);
  const db = database(env.DB);
  if (identity) {
    if (!headers.get("cookie")?.includes(`${DEMO_MODE_COOKIE}=`) || !demoSelected(headers, identity.session.id)) return identity;
    if (!identity.user.emailVerified) return null;
    return demoIdentity(db, { viewer: "member", viewerId: identity.user.id }, identity.session.expiresAt);
  }
  const guest = guestViewer(secrets(env).BETTER_AUTH_SECRET, cookieValue(headers, DEMO_GUEST_COOKIE));
  return guest ? demoIdentity(db, { viewer: "guest", viewerId: guest.id }, guest.expiresAt) : null;
}

export function cookieValue(headers: Headers, name: string): string | undefined {
  return headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
export const DEMO_READ_ONLY = "The demo is view-only. Create a free account to add your own records and documents.";
const readOnlyRefusal = () => Response.json({ error: DEMO_READ_ONLY }, { status: 403, headers: { "Cache-Control": "no-store" } });

// The demo is shared by everyone viewing it, so nothing a viewer does may change it. Applied in
// two places: here, for every route behind requireUser, and app-wide (`demoReadOnly`) for routes
// that resolve the identity themselves.
export function requireUser(whenSignedOut: "json" | "redirect" | { message: string }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const found = await applicationSession(c.env, c.req.raw.headers);
    if (!found) {
      if (whenSignedOut === "redirect") return c.redirect(new URL("/sign-in", c.req.url).toString());
      return c.json({ error: whenSignedOut === "json" ? "unauthenticated" : whenSignedOut.message }, 401, { "Cache-Control": "no-store" });
    }
    if ("demo" in found && !READS.has(c.req.method)) return readOnlyRefusal();
    c.set("userId", found.user.id);
    c.set("scope", forUser(database(c.env.DB), found.user.id));
    await next();
  };
}

// App-wide: any write carrying a demo cookie, outside sign-in/out (/api/auth) and the demo's own
// read-only endpoints (/api/demo), is refused when the request resolves to the demo.
export const demoReadOnly: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const cookie = c.req.header("cookie") ?? "";
  if (!READS.has(c.req.method) && (cookie.includes(`${DEMO_GUEST_COOKIE}=`) || cookie.includes(`${DEMO_MODE_COOKIE}=`)) && !/^\/api\/(auth|demo)\//.test(path)) {
    const found = await applicationSession(c.env, c.req.raw.headers);
    if (found && "demo" in found) return readOnlyRefusal();
  }
  await next();
};

// The demo holds fictional records only: no live health-system connections, even to read
// (Epic's authorize is a GET). After requireUser.
export function notInDemo(refuse: (c: Context<AppEnv>) => Response): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isDemoIdentity(c.get("userId"))) return refuse(c);
    await next();
  };
}
