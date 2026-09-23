import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";
import type { Db } from "./types";

// Standard Postgres wire protocol: Neon's pooled URL in Vercel, `npm run db:local` in development.
const pool = new Pool({ connectionString: env().DATABASE_URL, max: 5 });

// The cast erases the driver-specific result type; queries are identical.
export const db = drizzle(pool, { schema }) as unknown as Db;

export type { Db };
