import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";
describe("retired chat ticket route", () => {
  it("never mints a VPS browser credential, including with obsolete deployment configuration", async () => {
    vi.stubEnv("CHAT_API_URL", "https://obsolete-chat.example");
    vi.stubEnv("CHAT_SIGNING_KEY", "synthetic-obsolete-signing-key-for-tests");
    try {
      const response = await POST();
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: "chat_ticket_retired" });
      expect(response.headers.get("cache-control")).toContain("no-store");
    } finally { vi.unstubAllEnvs(); }
  });
});
