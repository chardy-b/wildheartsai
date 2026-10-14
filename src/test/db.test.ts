import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, expect, it } from "vitest";
import { user } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createTestDb, createTestUser } from "./db";

let shared: Db;
let scoped: PGlite;
beforeAll(async () => { shared = await createTestDb(); });

it("restores isolated migrated databases and retains suite-scoped fixtures", async () => {
  const isolated = await createTestDb();
  scoped = (isolated as unknown as { $client: PGlite }).$client;
  await createTestUser(shared, "shared-fixture");
  await createTestUser(isolated, "isolated-fixture");
  expect((await shared.select().from(user)).map((row) => row.id)).toEqual(["shared-fixture"]);
  expect((await isolated.select().from(user)).map((row) => row.id)).toEqual(["isolated-fixture"]);
});

it("closes test-scoped databases while keeping beforeAll databases usable", async () => {
  expect(scoped.closed).toBe(true);
  expect((await shared.select().from(user)).map((row) => row.id)).toEqual(["shared-fixture"]);
});
