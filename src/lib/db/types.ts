import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

// node-postgres (app) and PGlite (tests) both implement Drizzle's Postgres API.
// Repositories accept this type so tests can pass an in-memory database.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
