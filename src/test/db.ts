import { afterAll, onTestFinished, TestRunner } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import { user } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

let migrated: Promise<Blob> | undefined;
const clients = new Set<Promise<PGlite>>();

async function closeClient(pending: Promise<PGlite>) {
  const client = await pending;
  if (!client.closed) await client.close();
  clients.delete(pending);
}

// Databases created in beforeAll stay alive for the suite. Test-scoped databases
// close after that test, rather than retaining a Postgres WASM heap per fixture.
afterAll(async () => { await Promise.all([...clients].map(closeClient)); });

// Migrate and serialize once per worker. Each call restores its own isolated
// database from the immutable snapshot; it does not redump a live template.
export async function createTestDb(): Promise<Db> {
  migrated ??= (async () => {
    const template = new PGlite();
    try {
      await migrate(drizzle(template, { schema }), { migrationsFolder: "drizzle" });
      return await template.dumpDataDir("none");
    } finally {
      await template.close();
    }
  })();
  const pending = migrated.then((loadDataDir) => PGlite.create({ loadDataDir }));
  clients.add(pending);
  if (TestRunner.getCurrentTest()) onTestFinished(() => closeClient(pending));
  return drizzle(await pending, { schema }) as unknown as Db;
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
