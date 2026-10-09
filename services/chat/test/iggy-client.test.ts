import { it, expect, vi } from "vitest";
import { IggyClient } from "../src/iggy-client.js";

it("normalizes the actual Iggy lifecycle without treating provision/teardown/success as failures", async () => {
  let status = "queued";
  const fetcher: typeof fetch = vi.fn(async () => Response.json({ status }));
  const client = new IggyClient(new URL("http://localhost:8417"), "synthetic-token-long-enough", fetcher);
  for (const [value, expected] of [["queued", "queued"], ["provisioning", "running"], ["running", "running"], ["teardown", "running"], ["succeeded", "completed"], ["failed", "failed"], ["cancelled", "cancelled"]]) {
    status = value;
    await expect(client.getHealthRunStatus("synthetic-run")).resolves.toBe(expected);
  }
  status = "unknown-new-state";
  await expect(client.getHealthRunStatus("synthetic-run")).rejects.toThrow("iggy_unknown_status");
});

it("retries a lost Iggy start response with the same run ID and body", async () => {
  const calls: Array<{ url: string; body: string | undefined; redirect: RequestInit["redirect"] }> = [];
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), body: init?.body as string | undefined, redirect: init?.redirect });
    return calls.length === 1 ? Response.json({ error: "temporary" }, { status: 503 }) : new Response(null, { status: 202 });
  });
  const client = new IggyClient(new URL("http://localhost:8417"), "synthetic-token-long-enough", fetcher);
  await client.startHealthRun({ id: "20000000-0000-4000-8000-000000000001", capability: `whchat1.execution.${"e".repeat(43)}` });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]?.url).toBe("http://localhost:8417/v1/runs");
  expect(calls[0]?.redirect).toBe("error");
  expect(JSON.parse(calls[0]!.body!)).toMatchObject({ id: "20000000-0000-4000-8000-000000000001", profile: "health-chat/v1" });
});

it("rejects redirects and permanent or exhausted start failures", async () => {
  let redirectMode: RequestInit["redirect"];
  const redirectFetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    redirectMode = init?.redirect;
    return new Response(null, { status: 307, headers: { location: "https://attacker.example/collect" } });
  });
  const redirectClient = new IggyClient(new URL("http://localhost:8417"), "synthetic-token-long-enough", redirectFetcher);
  await expect(redirectClient.startHealthRun({ id: "20000000-0000-4000-8000-000000000001", capability: `whchat1.execution.${"e".repeat(43)}` })).rejects.toThrow("iggy_start_failed");
  expect(redirectFetcher).toHaveBeenCalledTimes(1);
  expect(redirectMode).toBe("error");

  const conflictFetcher: typeof fetch = vi.fn(async () => Response.json({ error: "idempotency_conflict" }, { status: 409 }));
  const conflictClient = new IggyClient(new URL("http://localhost:8417"), "synthetic-token-long-enough", conflictFetcher);
  await expect(conflictClient.startHealthRun({ id: "20000000-0000-4000-8000-000000000001", capability: `whchat1.execution.${"e".repeat(43)}` })).rejects.toThrow("iggy_start_failed");
  expect(conflictFetcher).toHaveBeenCalledTimes(1);

  const unavailableFetcher: typeof fetch = vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 }));
  const unavailableClient = new IggyClient(new URL("http://localhost:8417"), "synthetic-token-long-enough", unavailableFetcher);
  await expect(unavailableClient.startHealthRun({ id: "20000000-0000-4000-8000-000000000001", capability: `whchat1.execution.${"e".repeat(43)}` })).rejects.toThrow("iggy_start_failed");
  expect(unavailableFetcher).toHaveBeenCalledTimes(3);
});
