import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, createNonce } from "@/lib/csp";
import { logPageTraffic } from "@/lib/page-traffic-log";
import { PAGE_TRAFFIC_ROUTE_HEADER, trafficRoute } from "@/lib/traffic-route";

export function proxy(request: NextRequest) {
  // Optimistic check only: it keeps signed-out visitors away from /app quickly.
  // The real session check happens in src/app/(app)/app/layout.tsx.
  const { pathname } = request.nextUrl;
  if ((pathname === "/app" || pathname.startsWith("/app/")) && !getSessionCookie(request)) {
    if (request.method === "GET") logPageTraffic("anonymous", pathname, "redirect");
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  // A fresh nonce per request. Next.js reads it from the request's CSP header and
  // puts it on the scripts it renders.
  const csp = contentSecurityPolicy(createNonce(), {
    development: process.env.NODE_ENV === "development",
    https: request.nextUrl.protocol === "https:",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(PAGE_TRAFFIC_ROUTE_HEADER);
  if (request.method === "GET") requestHeaders.set(PAGE_TRAFFIC_ROUTE_HEADER, trafficRoute(pathname));
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Pages only: not API routes, build assets or generated images.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|opengraph-image).*)"],
};
