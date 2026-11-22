import { is } from "drizzle-orm";
import { getTableConfig as pgTableConfig, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
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
  const allPg = columnsByTable(postgres, (v): v is PgTable => is(v, PgTable), pgTableConfig);
  // Chat isn't copied: it never ran in production, and on Cloudflare its content lives in one
  // Durable Object per conversation (api/src/db/chat/schema.ts has what spans conversations).
  const CHAT = ["chat_conversation", "chat_coordinator", "chat_event", "chat_message", "chat_run", "chat_tool_call", "summary_evidence", "user_summary"];
  // Postgres-only columns: the token key roll's `_next` copies (on main). The copy writes them
  // into D1's own credential columns (api/scripts/copy-to-d1.ts, ROLLED), so D1 has no `_next`.
  const PG_ONLY: Record<string, string[]> = {
    epic_connection: ["sealed_access_token_next", "sealed_patient_id_next", "sealed_refresh_token_next"],
    metriport_connection: ["sealed_patient_id_next"],
  };
  const pg = Object.fromEntries(Object.entries(allPg).filter(([table]) => !CHAT.includes(table)).map(([table, columns]) => [table, columns.filter((c) => !PG_ONLY[table]?.includes(c))]));
  const d1 = columnsByTable(main, (v): v is SQLiteTable => is(v, SQLiteTable), sqliteTableConfig);

  it("has every Postgres table but chat's in the main database, and nothing else", () => {
    expect(Object.keys(allPg).filter((table) => CHAT.includes(table)).sort()).toEqual(CHAT);
    expect(Object.keys(d1).sort()).toEqual(Object.keys(pg).sort());
    expect(Object.keys(allPg)).toHaveLength(30);
  });

  // Columns D1 has that Postgres doesn't, each with a default so the Neon copy fills them.
  const D1_ONLY: Record<string, string[]> = { epic_directory_entry: ["generation"], epic_directory_import: ["generation"] };

  it("keeps every column name, adding only the listed D1 columns", () => {
    const withoutAdditions = Object.fromEntries(Object.entries(d1).map(([table, columns]) => [table, columns.filter((c) => !D1_ONLY[table]?.includes(c))]));
    expect(withoutAdditions).toEqual(pg);
    for (const [table, columns] of Object.entries(D1_ONLY)) for (const column of columns) expect(d1[table]).toContain(column);
  });
});
