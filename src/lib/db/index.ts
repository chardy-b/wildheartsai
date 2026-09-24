import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import { lazy } from "@/lib/lazy";
import * as schema from "./schema";
import type { Db } from "./types";

// Standard Postgres wire protocol: Neon's pooled URL in Vercel, `npm run db:local` in development.
// Created on first query, so builds don't need DATABASE_URL.
// The cast erases the driver-specific result type; queries are identical.
export const db = lazy(
  () => drizzle(new Pool({ connectionString: env().DATABASE_URL, max: 5 }), { schema }) as unknown as Db,
);

export type { Db };
