import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, createNonce } from "@/lib/csp";
import { DEMO_GUEST_COOKIE } from "@/lib/demo/cookies";

export function proxy(request: NextRequest) {
  // Optimistic check only: it keeps signed-out visitors away from /app quickly (a guest demo's
  // cookie counts: the API decides whether it's still valid).
  // The real session check happens in src/app/(app)/app/layout.tsx.
  const { pathname } = request.nextUrl;
  if ((pathname === "/app" || pathname.startsWith("/app/")) && !getSessionCookie(request) && !request.cookies.has(DEMO_GUEST_COOKIE)) {
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
  // Pages only: not API routes, build assets, the PDF viewer's files (public/pdfjs) or generated images.
  matcher: ["/((?!api/|_next/static|_next/image|pdfjs/|favicon.ico|icon.svg|opengraph-image).*)"],
};
