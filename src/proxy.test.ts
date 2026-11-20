import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("proxy in read-only mode (the cutover)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const request = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    proxy(new NextRequest(`http://localhost:3000${path}`, { method: init.method ?? "GET", headers: { cookie: "better-auth.session_token=abc.def", ...init.headers } }));

  it("refuses changes with a message, and lets viewing, sign-in and sign-out through", async () => {
    vi.stubEnv("MAINTENANCE_READ_ONLY", "1");
    for (const [method, path] of [["POST", "/api/wildcards"], ["PUT", "/api/wildcards/uploads/x/0"], ["DELETE", "/api/wildcards/x"], ["POST", "/api/chat/v1/conversations"], ["POST", "/api/auth/sign-up/email"], ["POST", "/api/extraction"], ["POST", "/api/inngest"]]) {
      const response = request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe("read_only");
    }
    for (const [method, path] of [["GET", "/api/wildcards"], ["POST", "/api/auth/sign-in/email"], ["POST", "/api/auth/sign-out"], ["GET", "/app"]]) {
      expect(request(path, { method }).status, `${method} ${path}`).not.toBe(503);
    }
  });

  it("sends Connect back to its page, and refuses server actions except reading a note", () => {
    vi.stubEnv("MAINTENANCE_READ_ONLY", "1");
    expect(request("/api/epic/authorize?iss=x").headers.get("location")).toBe("http://localhost:3000/app/connections?error=maintenance");
    expect(request("/api/epic/callback?code=x").headers.get("location")).toBe("http://localhost:3000/app/connections?error=maintenance");
    expect(request("/app/connections", { method: "POST", headers: { "next-action": "abc" } }).status).toBe(503);
    expect(request("/app/records/labs", { method: "POST", headers: { "next-action": "abc" } }).status).not.toBe(503);
  });

  it("changes nothing when off", () => {
    expect(request("/api/wildcards", { method: "POST" }).headers.get("x-middleware-next")).toBe("1");
    expect(request("/api/epic/authorize").headers.get("location")).toBeNull();
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
