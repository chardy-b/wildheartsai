import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./lib/csp";
import { proxy } from "./proxy";

describe("proxy", () => {
  it("redirects /app requests without a session cookie to sign-in", () => {
    const response = proxy(new NextRequest("http://localhost:3000/app"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in");
  });

  it("redirects nested /app pages too, but not pages that only start with 'app'", () => {
    expect(proxy(new NextRequest("http://localhost:3000/app/connections")).status).toBe(307);
    expect(proxy(new NextRequest("http://localhost:3000/apple")).headers.get("location")).toBeNull();
  });

  it("lets requests with a session cookie through", () => {
    const request = new NextRequest("http://localhost:3000/app", {
      headers: { cookie: "better-auth.session_token=abc.def" },
    });
    const response = proxy(request);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("sets a Content-Security-Policy with a fresh nonce on every page, and passes it to rendering", () => {
    const first = proxy(new NextRequest("http://localhost:3000/"));
    const second = proxy(new NextRequest("http://localhost:3000/"));
    const csp = first.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toBe(second.headers.get("content-security-policy"));
    expect(first.headers.get("x-middleware-override-headers")).toContain("content-security-policy");
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
  });
});

describe("contentSecurityPolicy", () => {
  it("allows only this origin's scripts with the nonce, and no framing, plugins or foreign forms", () => {
    const csp = contentSecurityPolicy("abc", { development: false, https: true });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic';");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("adds eval for development and leaves out the https upgrade on plain http", () => {
    const csp = contentSecurityPolicy("abc", { development: true, https: false });
    expect(csp).toContain("'strict-dynamic' 'unsafe-eval'");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});
