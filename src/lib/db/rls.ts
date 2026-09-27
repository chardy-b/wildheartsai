import { sql } from "drizzle-orm";
import type { Db } from "./types";

// Row-level security (migration 0006): the tables holding a person's records, tokens and
// history only show and accept that person's rows while `app.user_id` is set. The setting
// is transaction-local, so it can't leak to the next query on a pooled connection.
//
// Rollout: for now a query with no user set still sees every row (background jobs, and the
// previous deployment while a new one's migration runs). Once every query runs in a user
// or system context, a later migration makes an unset context see nothing.

export const RLS_TABLES = [
  "user_data_key",
  "health_source",
  "epic_connection",
  "fhir_resource",
  "fhir_attachment",
  "sync_run",
  "sync_cursor",
  "audit_event",
  "profile",
] as const;

export async function setUser(tx: Pick<Db, "execute">, userId: string): Promise<void> {
  if (!userId) throw new Error("setUser needs a user id");
  await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
}

// Runs `work` in a transaction where the database only shows `userId`'s rows. Keep network
// calls (Epic, the job queue) outside: the transaction holds a connection until it ends.
export function asUser<T>(db: Db, userId: string, work: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await setUser(tx, userId);
    return work(tx as unknown as Db);
  });
}
