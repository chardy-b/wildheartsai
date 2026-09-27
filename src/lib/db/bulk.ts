import { getTableColumns, is, SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./types";

// D1 allows at most 100 bound parameters per statement, so long ID and row lists travel
// as one JSON parameter and are read back with SQLite's json_each.

// Keeps each statement's JSON parameter well under D1's 2 MB value limit.
const MAX_JSON_CHARS = 1_000_000;

// `column in (…)` for any number of values: inArray(column, jsonValues(ids)).
export function jsonValues(values: readonly (string | number)[]): SQL {
  return sql`(select value from json_each(${JSON.stringify(values)}))`;
}

type Row<T extends SQLiteTable> = T["$inferInsert"];

// One INSERT for many rows, whatever their column count, as a batchable Drizzle query.
// Missing values take the column's default, as they would with .values().
export function insertRows<T extends SQLiteTable>(db: Db, table: T, rows: Row<T>[]) {
  const columns = Object.entries(getTableColumns(table));
  const values = rows.map((row) =>
    Object.fromEntries(
      columns.map(([key, column]) => {
        let value = (row as Record<string, unknown>)[key];
        if (value === undefined && column.defaultFn) value = column.defaultFn();
        if (value === undefined && column.default !== undefined && !is(column.default, SQL)) value = column.default;
        return [column.name, value === undefined || value === null ? null : column.mapToDriverValue(value)];
      }),
    ),
  );
  // Column names come from the schema, never from input.
  const picks = columns.map(([, column]) => {
    const pick = sql.raw(`value ->> '$.${column.name}'`);
    return is(column.default, SQL) ? sql`coalesce(${pick}, ${column.default})` : pick;
  });
  return db.insert(table).select(sql`select ${sql.join(picks, sql`, `)} from json_each(${JSON.stringify(values)})`);
}

// Splits items so each group's JSON stays within one statement's limit.
export function chunkBySize<T>(items: T[], size: (item: T) => number, limit = MAX_JSON_CHARS): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let total = 0;
  for (const item of items) {
    const n = size(item);
    if (current.length > 0 && total + n > limit) {
      out.push(current);
      current = [];
      total = 0;
    }
    current.push(item);
    total += n;
  }
  if (current.length > 0) out.push(current);
  return out;
}
