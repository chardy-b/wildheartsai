import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./csp";

const connectionPolicy = () => contentSecurityPolicy("nonce", { development: false, https: true }).split("; ").find(part => part.startsWith("connect-src"));

describe("content security policy", () => {
  it("keeps API connections same-origin", () => {
    expect(connectionPolicy()).toBe("connect-src 'self'");
  });
});
