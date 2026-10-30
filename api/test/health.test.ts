import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("/api/health", () => {
  it("answers without secrets or bindings", async () => {
    const response = await SELF.fetch("https://wildheartsai.test/api/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", service: "wildheartsai" });
  });

  it("returns a JSON 404 for unknown paths", async () => {
    const response = await SELF.fetch("https://wildheartsai.test/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
