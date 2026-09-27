import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import { lazy } from "@/lib/lazy";
import * as schema from "./schema";
import type { Db } from "./types";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The local PGlite server (`npm run db:local`) accepts few connections and runs queries one
// at a time anyway, so locally keep the pool small and let idle connections go quickly.
export function poolOptions(databaseUrl: string): { max: number; idleTimeoutMillis?: number } {
  return LOCAL_HOSTS.has(new URL(databaseUrl).hostname) ? { max: 2, idleTimeoutMillis: 2000 } : { max: 5 };
}

// One pool per process: `next dev` re-evaluates modules on every reload, and a new pool each
// time would leave the old pools' connections open until the local server starts refusing.
const shared = globalThis as typeof globalThis & { __wildheartsPool?: Pool };

function pool(): Pool {
  const url = env().DATABASE_URL;
  shared.__wildheartsPool ??= new Pool({ connectionString: url, ...poolOptions(url) });
  return shared.__wildheartsPool;
}

// Standard Postgres wire protocol: Neon's pooled URL in Vercel, `npm run db:local` in development.
// Created on first query, so builds don't need DATABASE_URL.
// The cast erases the driver-specific result type; queries are identical.
export const db = lazy(() => drizzle(pool(), { schema }) as unknown as Db);

export type { Db };
