import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jwtVerify } from "jose";
const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/env", () => ({ appUrl: () => "https://wildhearts.example" }));
import { POST } from "./route";

const key = "synthetic-chat-signing-key-for-tests-only";
function request(origin = "https://wildhearts.example") {
  return new Request("https://wildhearts.example/api/chat/ticket", { method: "POST", headers: { origin }, body: JSON.stringify({ userId: "another-user" }) });
}
beforeEach(() => {
  vi.stubEnv("CHAT_API_URL", "https://chat.example"); vi.stubEnv("CHAT_SIGNING_KEY", key);
  mocks.getSession.mockResolvedValue({ user: { id: "signed-in-user", emailVerified: true }, session: { id: "signed-in-session" } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("chat ticket route", () => {
  it("rejects cross-origin and anonymous requests before minting credentials", async () => {
    expect((await POST(request("https://attacker.example"))).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    mocks.getSession.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
  });
  it("uses the authenticated identity rather than submitted user identifiers and never caches credentials", async () => {
    const response = await POST(request());
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    const { payload } = await jwtVerify(body.token, new TextEncoder().encode(key), { algorithms: ["HS256"], audience: "wildhearts-chat" });
    expect(payload.sub).toBe("signed-in-user"); expect(payload.sid).toBe("signed-in-session");
    expect(JSON.stringify(body)).not.toContain(key);
  });
  it("fails closed while deployment configuration is absent", async () => {
    vi.stubEnv("CHAT_SIGNING_KEY", "");
    expect((await POST(request())).status).toBe(503);
  });
});
