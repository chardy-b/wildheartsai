import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy";

describe("proxy", () => {
  it("redirects /app requests without a session cookie to sign-in", () => {
    const response = proxy(new NextRequest("http://localhost:3000/app"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in");
  });

  it("lets requests with a session cookie through", () => {
    const request = new NextRequest("http://localhost:3000/app", {
      headers: { cookie: "better-auth.session_token=abc.def" },
    });
    const response = proxy(request);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
