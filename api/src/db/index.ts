import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = DrizzleD1Database<typeof schema>;

// The main database. Code serving a signed-in person reaches it only through
// `forUser` (src/data/scope.ts); jobs use `system`.
export function database(d1: D1Database): Db {
  return drizzle(d1, { schema });
}
