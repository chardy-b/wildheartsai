import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "./env";

// Postgres advisory locks (pg_advisory_xact_lock) kept work for one key one at a time where a
// rule spans several reads and writes (audit pattern L, docs/superpowers/specs/2026-10-30-d1-
// transaction-audit.md). Here one Durable Object per key runs that work strictly one call after
// another. The work itself runs in the caller's Worker (Workers RPC passes the function as a stub);
// the object only holds the turn, and releases it when the work ends, fails, or its caller is gone.
export class UserLock extends DurableObject<Bindings> {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await before;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

// Runs `work` while holding the lock named `key` (for instance "extraction:<userId>").
export async function withLock<T>(env: Bindings, key: string, work: () => Promise<T>): Promise<T> {
  const lock = env.USER_LOCK.get(env.USER_LOCK.idFromName(key));
  return (await lock.run(work)) as T;
}
