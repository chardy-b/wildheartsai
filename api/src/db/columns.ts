import { sql } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";

// Column conventions for the D1 port of the Postgres schema (src/lib/db/*-schema.ts).
// Table and column names must match Postgres exactly: sealed values are bound to
// `table:field:userId:rowId` (src/lib/crypto/user-keys.ts) and won't open if any part changes.

// Postgres `timestamp` → epoch milliseconds. Lossless for the app's millisecond Dates.
export const time = (name: string) => integer(name, { mode: "timestamp_ms" });

// Postgres `defaultNow()`, for rows written by raw SQL. Drizzle inserts set it in code too.
export const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

// Postgres `uuid` with `defaultRandom()`.
export const uuidPk = (name = "id") => text(name).primaryKey().$defaultFn(() => crypto.randomUUID());

// Postgres `boolean`.
export const bool = (name: string) => integer(name, { mode: "boolean" });

// Postgres `jsonb`.
export const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
