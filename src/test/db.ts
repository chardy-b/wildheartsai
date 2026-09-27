import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/d1";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll } from "vitest";
import * as schema from "@/lib/db/schema";
import { user } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

// A local Cloudflare D1 (Miniflare runs the same SQLite engine as production) with every
// migration in drizzle/ applied. Each call gets its own in-memory database.

const migrations = readdirSync("drizzle")
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .flatMap((name) => readFileSync(`drizzle/${name}`, "utf8").split("--> statement-breakpoint"))
  .map((statement) => statement.trim())
  .filter(Boolean);

const running: Miniflare[] = [];

afterAll(async () => {
  await Promise.all(running.splice(0).map((mf) => mf.dispose()));
});

export async function createTestD1(): Promise<D1Database> {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response(null, { status: 404 }); } }",
      compatibilityDate: "2026-09-01",
      d1Databases: { DB: "test" },
      d1Persist: false,
    }),
  );
  running.push(mf);
  const d1 = await mf.getD1Database("DB");
  await d1.batch(migrations.map((statement) => d1.prepare(statement)));
  return d1 as unknown as D1Database;
}

export async function createTestDb(): Promise<Db> {
  return drizzle(await createTestD1(), { schema });
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
