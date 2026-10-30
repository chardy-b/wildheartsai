import { is } from "drizzle-orm";
import { getTableConfig as pgTableConfig, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import * as chat from "../src/db/chat/schema";
import * as main from "../src/db/schema";
// The Postgres schema of the app being migrated, read for names only. It loads the root
// install's drizzle copy, so tables are recognized with `is()` rather than instanceof.
import * as postgres from "../../src/lib/db/schema";

// The data copy (Neon → D1) and every sealed value depend on table and column names staying
// identical: sealed fields are bound to `table:field:userId:rowId`.
function columnsByTable<T>(tables: Record<string, unknown>, isTable: (value: unknown) => value is T, config: (table: T) => { name: string; columns: { name: string }[] }) {
  return Object.fromEntries(
    Object.values(tables)
      .filter(isTable)
      .map((table) => {
        const { name, columns } = config(table);
        return [name, columns.map((column) => column.name).sort()];
      }),
  );
}

describe("D1 schema parity with Postgres", () => {
  const pg = columnsByTable(postgres, (v): v is PgTable => is(v, PgTable), pgTableConfig);
  const d1 = {
    ...columnsByTable(main, (v): v is SQLiteTable => is(v, SQLiteTable), sqliteTableConfig),
    ...columnsByTable(chat, (v): v is SQLiteTable => is(v, SQLiteTable), sqliteTableConfig),
  };

  it("has every Postgres table, split between the main and chat databases, and nothing else", () => {
    expect(Object.keys(d1).sort()).toEqual(Object.keys(pg).sort());
    expect(Object.keys(pg)).toHaveLength(30);
  });

  it("keeps every column name", () => {
    expect(d1).toEqual(pg);
  });
});
