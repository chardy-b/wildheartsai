import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./csp";
import { chatConfiguration } from "./chat-auth/configuration";

const connectionPolicy = (chatApiOrigin?: string) => contentSecurityPolicy("nonce", { development: false, https: true, chatApiOrigin }).split("; ").find(part => part.startsWith("connect-src"));

describe("chat API content security policy", () => {
  it("allows only the configured canonical origin for browser requests and SSE", () => {
    expect(connectionPolicy("https://CHAT.example.com:8443/")).toBe("connect-src 'self' https://chat.example.com:8443");
    expect(connectionPolicy("http://127.0.0.1:18083")).toBe("connect-src 'self' http://127.0.0.1:18083");
  });
  it("keeps disabled chat and invalid endpoints self-only", () => {
    expect(connectionPolicy(chatConfiguration({})?.apiUrl)).toBe("connect-src 'self'");
    expect(connectionPolicy(chatConfiguration({ CHAT_API_URL: "https://chat.example.com" })?.apiUrl)).toBe("connect-src 'self'");
    for (const endpoint of ["https://*.example.com", "https://chat.example.com;script-src", "https://chat.example.com%3bfoo", 'https://chat.example.com"', "https://user:pass@chat.example.com", "https://chat.example.com/v1", "https://chat.example.com?token=x", "https://chat.example.com#fragment", "http://chat.example.com", "http://localhost.example.com", "javascript:alert(1)"]) {
      expect(connectionPolicy(endpoint)).toBe("connect-src 'self'");
      expect(chatConfiguration({ CHAT_API_URL: endpoint, CHAT_SIGNING_KEY: "x".repeat(32) })).toBeNull();
    }
  });
});
