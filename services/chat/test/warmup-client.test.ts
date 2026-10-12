import { describe, expect, it, vi } from "vitest";
import { GatewayWarmupClient } from "../src/warmup-client.js";

const lease = {
  grant: `whchat1.warmup.${"w".repeat(43)}`,
  leaseId: "20000000-0000-4000-8000-000000000002",
  generation: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  requestId: "20000000-0000-4000-8000-000000000003",
  workerId: "worker-test",
};

describe("fixed private model warm-up client", () => {
  it("sends only the opaque lease to the fixed gateway and parses a bounded status", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://wildhearts-chat-gateway:8080/v1/warmup");
      expect(init?.method).toBe("POST");
      return Response.json({ status: "ready" });
    });
    const client = new GatewayWarmupClient(fetcher);
    await expect(client.run(lease)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("http://wildhearts-chat-gateway:8080/v1/warmup");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${lease.grant}`);
    expect(init?.body).toBe("{}");
  });

  it("fails closed on bad status and expired leases", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "failed", answer: "private" }));
    const client = new GatewayWarmupClient(fetcher);
    await expect(client.run(lease)).resolves.toBe(false);
    await expect(client.run({ ...lease, expiresAt: new Date(Date.now() - 1_000).toISOString() })).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
