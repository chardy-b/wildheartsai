import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/test/db";

describe("database migrations", () => {
  it("create the Better Auth tables", async () => {
    const db = await createTestDb();
    const rows = await db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table' order by name`);
    const names = rows.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["account", "session", "user", "verification"]));
  });
});
