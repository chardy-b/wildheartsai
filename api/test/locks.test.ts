import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import { withLock } from "../src/locks";

// The Durable Object lock that stands in for Postgres advisory locks.
const bindings = env as unknown as Bindings;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withLock", () => {
  it("runs work for one key one call at a time, and keys apart independently", async () => {
    const events: string[] = [];
    const job = (key: string, name: string) =>
      withLock(bindings, key, async () => {
        events.push(`start ${name}`);
        await pause(30);
        events.push(`end ${name}`);
        return name;
      });
    const results = await Promise.all([job("a", "a1"), job("a", "a2"), job("a", "a3"), job("b", "b1")]);
    expect(results).toEqual(["a1", "a2", "a3", "b1"]);
    const forA = events.filter((e) => e.endsWith("a1") || e.endsWith("a2") || e.endsWith("a3"));
    // Never two a-jobs open at once.
    for (let i = 0; i < forA.length; i += 2) expect([forA[i].split(" ")[0], forA[i + 1].split(" ")[0]]).toEqual(["start", "end"]);
    // b didn't wait for the a's.
    expect(events.indexOf("start b1")).toBeLessThan(events.indexOf("end a3"));
  });

  it("releases the lock when the work fails", async () => {
    await expect(withLock(bindings, "c", async () => { throw new Error("made-up failure"); })).rejects.toThrow("made-up failure");
    expect(await withLock(bindings, "c", async () => "after")).toBe("after");
  });
});
