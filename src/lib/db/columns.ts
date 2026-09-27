import { sql } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";

// D1 is SQLite: no native timestamp, uuid or jsonb types. Timestamps are stored as
// milliseconds since the epoch (read back as Date), IDs as text UUIDs made in the app.

const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

export function timestamp(name: string) {
  return integer(name, { mode: "timestamp_ms" });
}

export const createdAt = (name = "created_at") => timestamp(name).notNull().default(nowMs);
export const updatedAt = (name = "updated_at") => timestamp(name).notNull().default(nowMs);

export function uuid(name: string) {
  return text(name);
}

export function uuidPrimaryKey(name = "id") {
  return text(name)
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
}
