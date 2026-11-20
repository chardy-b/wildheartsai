import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, createNonce } from "@/lib/csp";
import { READ_ONLY_MESSAGE, readOnly, readOnlyRefusal } from "@/lib/read-only";

export function proxy(request: NextRequest) {
  // Read-only mode during the cutover (src/lib/read-only.ts).
  if (readOnly()) {
    const refusal = readOnlyRefusal(request.method, request.nextUrl.pathname, request.headers.has("next-action"));
    if (refusal === "redirect") return NextResponse.redirect(new URL("/app/connections?error=maintenance", request.url));
    if (refusal === "json") return NextResponse.json({ error: READ_ONLY_MESSAGE, code: "read_only" }, { status: 503, headers: { "Retry-After": "300", "Cache-Control": "no-store" } });
  }
  // API routes are here only for read-only mode: nothing else applies to them.
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();

  // Optimistic check only: it keeps signed-out visitors away from /app quickly.
  // The real session check happens in src/app/(app)/app/layout.tsx.
  const { pathname } = request.nextUrl;
  if ((pathname === "/app" || pathname.startsWith("/app/")) && !getSessionCookie(request)) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  // A fresh nonce per request. Next.js reads it from the request's CSP header and
  // puts it on the scripts it renders.
  const csp = contentSecurityPolicy(createNonce(), {
    development: process.env.NODE_ENV === "development",
    https: request.nextUrl.protocol === "https:",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Pages (not build assets or generated images), and API routes for read-only mode.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|opengraph-image).*)", "/api/:path*"],
};
