import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
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

    insert<T extends UserTable>(table: T, rows: T["$inferInsert"] | T["$inferInsert"][]) {
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
  };
}

// Background jobs and operator tasks that work across people (the nightly refresh, the
// directory import, queue claims). Named so every unscoped use is easy to find and review.
export function system(db: Db): Db {
  return db;
}
