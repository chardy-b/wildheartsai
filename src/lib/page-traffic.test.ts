import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ headers: vi.fn(), getSession: vi.fn() }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("./session", () => ({ getSession: mocks.getSession }));

import { logPageRequest } from "./page-traffic";
import { PAGE_TRAFFIC_ROUTE_HEADER } from "./traffic-route";

describe("page request authentication labels", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "info").mockImplementation(() => undefined); });
  afterEach(() => vi.restoreAllMocks());

  function request(cookie?: string) {
    mocks.headers.mockResolvedValue(new Headers({
      [PAGE_TRAFFIC_ROUTE_HEADER]: "/app/wildcards/private-id",
      ...(cookie ? { cookie } : {}),
    }));
  }

  it("does not look up a session for a visitor with no session cookie", async () => {
    request();
    await logPageRequest();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toEqual({
      event: "page_request", authState: "anonymous", route: "/app/wildcards/[id]", outcome: "render",
    });
  });

  it("does not treat a forged or expired cookie as authenticated", async () => {
    request("better-auth.session_token=forged.cookie");
    mocks.getSession.mockResolvedValue(null);
    await logPageRequest();
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"authState":"anonymous"'));
  });

  it("logs only a verified state, never the session, user details or raw resource ID", async () => {
    request("__Secure-better-auth.session_token=synthetic.cookie");
    mocks.getSession.mockResolvedValue({ user: { id: "private-user", email: "private@example.com" }, session: { token: "secret-session" } });
    await logPageRequest();
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toEqual({
      event: "page_request", authState: "authenticated", route: "/app/wildcards/[id]", outcome: "render",
    });
  });

  it("keeps public pages working during an auth failure and does not log the exception", async () => {
    request("better-auth.session_token=synthetic.cookie");
    mocks.getSession.mockRejectedValue(new Error("private-database-url"));
    await expect(logPageRequest()).resolves.toBeUndefined();
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toEqual({
      event: "page_request", authState: "unknown", route: "/app/wildcards/[id]", outcome: "render",
    });
  });

  it("does not log requests without the proxy's page marker", async () => {
    mocks.headers.mockResolvedValue(new Headers());
    await logPageRequest();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });
});
