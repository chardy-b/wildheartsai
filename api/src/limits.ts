import { DurableObject } from "cloudflare:workers";
import type { Context, MiddlewareHandler } from "hono";
import type { Bindings } from "./env";

// Strict limits on what costs storage or compute: starting a guest demo, uploading files, and
// (with the chat port) asking questions. One `RateLimiter` object per key counts hits in a
// sliding window; it keeps only timestamps, never content. Keys are a person's id or the
// client's IP (`cf-connecting-ip`, which Cloudflare sets and the web Worker forwards as is).

const MINUTE = 60_000, HOUR = 60 * MINUTE;

export const LIMITS = {
  // New guest demos from one network. A shared network (a class, a conference) fits a few.
  guestDemoPerIp: { limit: 10, windowMs: HOUR },
  // Files started in Documents (each file of a folder is one). Pieces of a file aren't counted.
  uploadPerPerson: { limit: 100, windowMs: HOUR },
  uploadPerIp: { limit: 300, windowMs: HOUR },
  // The demo's sample PDF, and its sync and reset (each writes the whole fictional chart).
  demoWritePerPerson: { limit: 30, windowMs: HOUR },
  demoWritePerIp: { limit: 120, windowMs: HOUR },
} as const satisfies Record<string, { limit: number; windowMs: number }>;
export type LimitName = keyof typeof LIMITS;

export class RateLimiter extends DurableObject<Bindings> {
  // Storage calls hold the object's input gate, so concurrent takes for one key don't interleave.
  async take(limit: number, windowMs: number, now = Date.now()): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
    const hits = ((await this.ctx.storage.get<number[]>("hits")) ?? []).filter((at) => at > now - windowMs);
    if (hits.length >= limit) {
      await this.ctx.storage.put("hits", hits);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000)) };
    }
    hits.push(now);
    await this.ctx.storage.put("hits", hits);
    // Forget the key once its window has passed.
    await this.ctx.storage.setAlarm(now + windowMs);
    return { ok: true };
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

export const clientIp = (headers: Headers) => headers.get("cf-connecting-ip") ?? "unknown";

// Counts one hit against every (limit, key) pair; refused if any is over. Every pair is counted
// even when an earlier one refuses, so hammering one key can't be used to dodge another.
export async function allow(env: Bindings, checks: [LimitName, string][]): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const results = await Promise.all(
    checks.map(([name, key]) => {
      const { limit, windowMs } = LIMITS[name];
      return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${name}:${key}`)).take(limit, windowMs);
    }),
  );
  const refused = results.filter((r) => !r.ok) as { retryAfterSeconds: number }[];
  return refused.length ? { ok: false, retryAfterSeconds: Math.max(...refused.map((r) => r.retryAfterSeconds)) } : { ok: true };
}

export function tooMany(retryAfterSeconds: number, message = "Too many requests. Try again later.") {
  return Response.json({ error: message }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" } });
}

// Middleware form: `checks` reads the person (after requireUser) or the request.
export function rateLimited<E extends { Bindings: Bindings }>(checks: (c: Context<E>) => [LimitName, string][], message?: string): MiddlewareHandler<E> {
  return async (c, next) => {
    const outcome = await allow(c.env, checks(c));
    if (!outcome.ok) return tooMany(outcome.retryAfterSeconds, message);
    await next();
  };
}
