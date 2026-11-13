import { and, eq, getTableColumns, getTableName, inArray, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn, SelectedFields, SQLiteColumn, SQLiteInsertValue, SQLiteSelect, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "../db";
import * as schema from "../db/schema";

// Replaces Postgres row-level security (src/lib/db/rls.ts in the Next app). D1 has no RLS, so
// per-person isolation is enforced here: `forUser` adds the owner condition to every query it
// builds, and route code never touches tables directly (lint rule in eslint.config.mjs).
// Design: docs/superpowers/plans/2026-10-30-cloudflare-migration.md, "Replacing row-level security".
//
// Drizzle's builders drop a method once it's been called, so a caller can't call `.where()`
// again on what these return and replace the owner condition.

// Tables holding a person's data, owned through their user_id column. A new table with a
// user_id column must be added here, to SOURCE_SCOPED_TABLES or to SYSTEM_TABLES, or
// test/user-tables.test.ts fails.
export const USER_TABLES = {
  userDataKey: schema.userDataKey,
  healthSource: schema.healthSource,
  epicConnection: schema.epicConnection,
  metriportConnection: schema.metriportConnection,
  fhirResource: schema.fhirResource,
  fhirAttachment: schema.fhirAttachment,
  syncRun: schema.syncRun,
  auditEvent: schema.auditEvent,
  profile: schema.profile,
  wildcardFile: schema.wildcardFile,
  extractionRun: schema.extractionRun,
  extractionJob: schema.extractionJob,
  extractionReference: schema.extractionReference,
} as const;

// A person's data without a user_id: owned through the health source it belongs to.
export const SOURCE_SCOPED_TABLES = { syncCursor: schema.syncCursor } as const;

// Not a person's records: Better Auth's own tables (read and written by Better Auth, which
// scopes them itself) and public or operational data.
export const SYSTEM_TABLES = {
  user: schema.user,
  session: schema.session,
  account: schema.account,
  verification: schema.verification,
  rateLimit: schema.rateLimit,
  epicDirectoryEntry: schema.epicDirectoryEntry,
  epicDirectoryImport: schema.epicDirectoryImport,
  backgroundJobRun: schema.backgroundJobRun,
} as const;

export type UserTable = (typeof USER_TABLES)[keyof typeof USER_TABLES];
type Owned = SQLiteTable & { userId: SQLiteColumn };
type SourceScoped = typeof schema.syncCursor;

export class ScopeError extends Error {}

// A statement for `batch`: a drizzle builder, or one made by `bulkInsert`.
export type Statement = { toSQL(): { sql: string; params: unknown[] } };

// D1 caps a value (and a row) at about 2 MB; bulk statements stay well under it.
const BULK_BYTES = 800_000;

export type UserScope = ReturnType<typeof forUser>;

export function forUser(db: Db, userId: string) {
  if (!userId) throw new ScopeError("forUser needs a user id");

  // The owner condition for a table: its user_id, or for a cursor, its source's.
  function owns(table: Owned | SourceScoped): SQL {
    if (table === schema.syncCursor) {
      return inArray(
        schema.syncCursor.sourceId,
        db.select({ id: schema.healthSource.id }).from(schema.healthSource).where(eq(schema.healthSource.userId, userId)),
      );
    }
    return eq((table as Owned).userId, userId);
  }

  function assertOwnRows(rows: readonly { userId?: unknown }[]) {
    for (const row of rows) {
      if (row.userId !== userId) throw new ScopeError("Rows written through forUser must belong to its user");
    }
  }

  // No `db` here: handing it out would let callers skip the owner condition.
  return {
    userId,
    owns,

    select<T extends Owned | SourceScoped>(table: T, where?: SQL) {
      return db.select().from(table).where(and(owns(table), where));
    },

    // Chosen columns or expressions (aggregates, for instance), still only the person's rows.
    selectFields<F extends SelectedFields, T extends Owned | SourceScoped>(table: T, fields: F, where?: SQL) {
      return db.select(fields).from(table as SQLiteTable).where(and(owns(table), where));
    },

    // Values may be SQL (a subquery for an id written in the same batch); user_id never is.
    insert<T extends UserTable>(table: T, rows: SQLiteInsertValue<T> | SQLiteInsertValue<T>[]) {
      const list = Array.isArray(rows) ? rows : [rows];
      assertOwnRows(list as { userId?: unknown }[]);
      return db.insert(table).values(list as never);
    },

    update<T extends Owned | SourceScoped>(table: T, values: Partial<T["$inferInsert"]>, where?: SQL) {
      if ("userId" in values && values.userId !== userId) throw new ScopeError("forUser can't move rows to another user");
      // A cursor's owner is its source's owner, so moving it to another source could hand it to someone else.
      if (table === schema.syncCursor && "sourceId" in values) throw new ScopeError("forUser can't move a cursor to another source");
      return db.update(table as SQLiteTable).set(values as never).where(and(owns(table), where));
    },

    delete<T extends Owned | SourceScoped>(table: T, where?: SQL) {
      return db.delete(table as SQLiteTable).where(and(owns(table), where));
    },

    // INSERT … SELECT over this person's rows: the select comes from this scope (so carries the
    // owner condition) and inserts nothing when it matches nothing, which makes it the guard in
    // the audit's "guarded batch" pattern. The select must set user_id to this scope's user;
    // only src/data builds these (see auditFrom).
    insertSelect<T extends UserTable>(table: T, query: SQLiteSelect) {
      return db.insert(table).select(query as never);
    },

    // Where a source's incremental sync resumes from. sync_cursor has no user_id: the row is
    // written only if the source is this person's (INSERT … SELECT from their health_source row).
    upsertCursor(sourceId: string, queryKey: string, patch: Partial<Pick<typeof schema.syncCursor.$inferInsert, "lastSuccessAt" | "lastFullAt" | "supportsLastUpdated">>) {
      const c = schema.syncCursor;
      const value = (column: SQLiteColumn, v: unknown, alias: string) => sql`${v === undefined || v === null ? null : column.mapToDriverValue(v)}`.as(alias);
      const row = db
        .select({
          sourceId: schema.healthSource.id,
          queryKey: sql<string>`${queryKey}`.as("query_key"),
          lastSuccessAt: value(c.lastSuccessAt, patch.lastSuccessAt, "last_success_at"),
          lastFullAt: value(c.lastFullAt, patch.lastFullAt, "last_full_at"),
          supportsLastUpdated: value(c.supportsLastUpdated, patch.supportsLastUpdated, "supports_last_updated"),
        })
        .from(schema.healthSource)
        .where(and(eq(schema.healthSource.id, sourceId), eq(schema.healthSource.userId, userId)));
      return db
        .insert(c)
        .select(row as never)
        .onConflictDoUpdate({ target: [c.sourceId, c.queryKey], set: patch as never });
    },

    // Many rows in few statements: each statement inserts a chunk of rows passed as one JSON
    // parameter (`json_each`), so neither D1's 100-parameter limit nor its per-invocation query
    // limit is reached by a 10,000-record search. Rows must belong to this scope's user, and all
    // carry the same columns. Returns statements for `batch`.
    bulkInsert<T extends UserTable>(table: T, rows: T["$inferInsert"][], options: { onConflictDoNothing?: boolean } = {}): Statement[] {
      assertOwnRows(rows as { userId?: unknown }[]);
      if (rows.length === 0) return [];
      const columns = Object.entries(getTableColumns(table)) as [string, AnySQLiteColumn][];
      const driverRows = rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, column] of columns) {
          const value = (row as Record<string, unknown>)[key] !== undefined ? (row as Record<string, unknown>)[key] : column.defaultFn?.();
          if (value !== undefined) out[column.name] = value === null ? null : column.mapToDriverValue(value);
        }
        return out;
      });
      const names = Object.keys(driverRows[0]);
      if (driverRows.some((row) => Object.keys(row).length !== names.length || names.some((name) => !(name in row)))) {
        throw new ScopeError("bulkInsert rows must carry the same columns");
      }
      const text = `insert into "${getTableName(table)}" (${names.map((n) => `"${n}"`).join(", ")}) select ${names
        .map((n) => `json_extract(value, '$."${n}"')`)
        .join(", ")} from json_each(?)${options.onConflictDoNothing ? " where true on conflict do nothing" : ""}`;
      const statements: Statement[] = [];
      let chunk: string[] = [];
      let bytes = 0;
      const flush = () => {
        const json = `[${chunk.join(",")}]`;
        statements.push({ toSQL: () => ({ sql: text, params: [json] }) });
        chunk = [];
        bytes = 0;
      };
      for (const row of driverRows) {
        const json = JSON.stringify(row);
        if (chunk.length && bytes + json.length > BULK_BYTES) flush();
        chunk.push(json);
        bytes += json.length;
      }
      flush();
      return statements;
    },

    // Runs statements built by this scope as one atomic unit (D1 has no interactive
    // transactions; see docs/superpowers/specs/2026-10-30-d1-transaction-audit.md). Runs on D1
    // directly, so bulk statements and builders share the batch (drizzle's own batch can't take
    // raw statements). Returns each statement's rows as D1 gives them: column names, raw values.
    async batch(statements: Statement[]): Promise<Record<string, unknown>[][]> {
      if (statements.length === 0) return [];
      const client = db.$client;
      const results = await client.batch(
        statements.map((statement) => {
          const query = statement.toSQL();
          return client.prepare(query.sql).bind(...query.params);
        }),
      );
      return results.map((result) => (result.results ?? []) as Record<string, unknown>[]);
    },
  };
}

// Background jobs and operator tasks that work across people (the nightly refresh, the
// directory import, queue claims). Named so every unscoped use is easy to find and review.
export function system(db: Db): Db {
  return db;
}

// D1 allows at most 100 bound parameters per statement. Runs `query` over slices of `values`
// small enough to leave room for the statement's other parameters, and joins the results.
export const PARAMETER_SLICE = 80;

export async function inSlices<V, R>(values: readonly V[], query: (slice: V[]) => Promise<R[]>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < values.length; i += PARAMETER_SLICE) results.push(...(await query(values.slice(i, i + PARAMETER_SLICE))));
  return results;
}

// `column in (values)` with the values as one JSON parameter, for id lists of any length (in a
// scope's update or delete, which adds the owner condition).
export function inJson(column: SQLiteColumn, values: readonly unknown[]): SQL {
  return sql`${column} in (select value from json_each(${JSON.stringify(values)}))`;
}
