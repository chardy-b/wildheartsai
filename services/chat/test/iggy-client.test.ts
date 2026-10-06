import { it, expect, vi } from "vitest";
import { IggyClient } from "../src/iggy-client.js";

it("normalizes the actual Iggy lifecycle without treating provision/teardown/success as failures", async () => {
  const client = new IggyClient(new URL("http://localhost:8417"), "synthetic-token");
  const original = globalThis.fetch;
  try {
    for (const [status, expected] of [["queued", "queued"], ["provisioning", "running"], ["running", "running"], ["teardown", "running"], ["succeeded", "completed"], ["failed", "failed"], ["cancelled", "cancelled"]]) {
      globalThis.fetch = vi.fn(async () => Response.json({ status }));
      await expect(client.getHealthRunStatus("synthetic-run")).resolves.toBe(expected);
    }
    globalThis.fetch = vi.fn(async () => Response.json({ status: "unknown-new-state" }));
    await expect(client.getHealthRunStatus("synthetic-run")).rejects.toThrow("iggy_unknown_status");
  } finally { globalThis.fetch = original; }
});
