import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import { user } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

let migrated: Promise<PGlite> | undefined;

// An in-memory Postgres with every migration in drizzle/ applied. Migrations run once per
// test worker; each call gets its own clone, so tests stay isolated without paying for them again.
export async function createTestDb(): Promise<Db> {
  migrated ??= (async () => {
    const template = new PGlite();
    await migrate(drizzle(template, { schema }), { migrationsFolder: "drizzle" });
    return template;
  })();
  const client = (await (await migrated).clone()) as PGlite;
  return drizzle(client, { schema }) as unknown as Db;
}

export async function createTestUser(db: Db, id = "user_test_1"): Promise<string> {
  const now = new Date();
  await db.insert(user).values({
    id,
    name: "Test Person",
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
