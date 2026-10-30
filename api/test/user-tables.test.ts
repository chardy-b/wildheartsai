import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { SOURCE_SCOPED_TABLES, SYSTEM_TABLES, USER_TABLES } from "../src/data/scope";
import * as schema from "../src/db/schema";

// Successor of `npm run db:check-rls`: every table in the main database is classified exactly
// once, and every table with a user_id column is either scoped by forUser or a reviewed system table.
describe("table classification", () => {
  const all = (Object.values(schema) as unknown[]).filter((value): value is SQLiteTable => value instanceof SQLiteTable);
  const classified = [...Object.values(USER_TABLES), ...Object.values(SOURCE_SCOPED_TABLES), ...Object.values(SYSTEM_TABLES)] as SQLiteTable[];

  it("classifies every table exactly once", () => {
    const names = (tables: SQLiteTable[]) => tables.map((t) => getTableConfig(t).name).sort();
    expect(names(classified)).toEqual(names(all));
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("scopes every table with a user_id, except Better Auth's", () => {
    const withUserId = all.filter((t) => getTableConfig(t).columns.some((c) => c.name === "user_id"));
    const unscoped = withUserId.filter((t) => !(Object.values(USER_TABLES) as SQLiteTable[]).includes(t)).map((t) => getTableConfig(t).name);
    expect(unscoped.sort()).toEqual(["account", "session"]);
  });
});
