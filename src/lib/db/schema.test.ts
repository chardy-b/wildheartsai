import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/test/db";

describe("database migrations", () => {
  it("create the Better Auth tables", async () => {
    const db = await createTestDb();
    // The shared Db type leaves raw query results untyped; PGlite returns { rows }.
    const result = (await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    )) as { rows: { table_name: string }[] };
    const names = result.rows.map((row) => row.table_name);
    expect(names).toEqual(expect.arrayContaining(["account", "session", "user", "verification"]));
  });
});
