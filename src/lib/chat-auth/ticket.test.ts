import { describe, expect, it } from "vitest";
import { jwtVerify } from "jose";
import { chatConfiguration, mintChatTicket } from "./ticket";

describe("chat browser tickets", () => {
  it("keeps chat disabled until a valid private signing key and safe endpoint exist", () => {
    expect(chatConfiguration({})).toBeNull();
    for (const CHAT_API_URL of ["http://chat.example.com", "https://user:pass@chat.example.com", "https://chat.example.com?token=x"]) {
      expect(chatConfiguration({ CHAT_API_URL, CHAT_SIGNING_KEY: "x".repeat(32) })).toBeNull();
    }
    expect(chatConfiguration({ CHAT_API_URL: "http://localhost:4100", CHAT_SIGNING_KEY: "x".repeat(32) })?.apiUrl).toBe("http://localhost:4100");
  });
  it("binds identity and session with a short expiry and distinct audience", async () => {
    const key = "test-only-chat-signing-key-32-characters";
    const token = await mintChatTicket({ userId: "synthetic-user", sessionId: "synthetic-session" }, key);
    const { payload } = await jwtVerify(token, new TextEncoder().encode(key), { audience: "wildhearts-chat", algorithms: ["HS256"] });
    expect(payload.sub).toBe("synthetic-user");
    expect(payload.sid).toBe("synthetic-session");
    expect(payload.exp! - payload.iat!).toBe(90);
    expect(payload.jti).toBeTruthy();
    await expect(jwtVerify(token, new TextEncoder().encode(key), { audience: "worker" })).rejects.toThrow();
  });
});
