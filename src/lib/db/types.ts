import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./schema";

// Cloudflare D1 through Drizzle, in the app and in tests (Miniflare's local D1).
// D1 has no interactive transactions: group writes that must land together with `db.batch`.
export type Db = DrizzleD1Database<typeof schema>;
