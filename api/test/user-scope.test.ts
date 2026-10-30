import { env } from "cloudflare:test";
import { eq, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import { forUser, ScopeError, SOURCE_SCOPED_TABLES, USER_TABLES } from "../src/data/scope";
import { database } from "../src/db";
import * as s from "../src/db/schema";
import { clearPeople, ownedRows, seedPerson } from "./fixtures";

// The successor of the Postgres RLS tests: for every table holding a person's data, a person's
// scope never reads, changes or deletes another person's rows, and can't write rows for them.
const db = database(env.DB);
const A = "person-a";
const B = "person-b";

type Scoped = Parameters<ReturnType<typeof forUser>["select"]>[0];

// Which person a row belongs to: its user_id, or for a cursor, its source's owner.
async function ownerOf(table: SQLiteTable): Promise<(row: Record<string, unknown>) => string> {
  if (table !== s.syncCursor) return (row) => row.userId as string;
  const sources = new Map((await db.select().from(s.healthSource)).map((source) => [source.id, source.userId]));
  return (row) => sources.get(row.sourceId as string)!;
}

async function ownersOf(table: SQLiteTable): Promise<string[]> {
  const owner = await ownerOf(table);
  return ((await db.select().from(table)) as Record<string, unknown>[]).map(owner).sort();
}

const tables = [...Object.entries(USER_TABLES), ...Object.entries(SOURCE_SCOPED_TABLES)] as [string, Scoped][];

beforeEach(async () => {
  await clearPeople(db);
  await seedPerson(db, A);
  await seedPerson(db, B);
});

describe.each(tables)("%s", (key, table) => {
  const seeded = ownedRows(A).filter((r) => r.key === key);

  it("is covered by the fixtures", () => {
    expect(seeded.length).toBeGreaterThan(0);
  });

  it("reads only the person's own rows", async () => {
    const rows = await forUser(db, A).select(table);
    expect(rows).toHaveLength(seeded.length);
    const all = await ownersOf(table);
    expect(all.filter((owner) => owner === B)).toHaveLength(seeded.length);
  });

  it("updates only the person's own rows", async () => {
    const [field, value] = Object.entries(seeded[0].touch)[0];
    const touched = (row: Record<string, unknown>) => JSON.stringify(row[field]) === JSON.stringify(value);
    const owner = await ownerOf(table);
    await forUser(db, A).update(table, seeded[0].touch as never);
    const rows = (await db.select().from(table)) as Record<string, unknown>[];
    expect(rows.filter((row) => owner(row) === A).every(touched)).toBe(true);
    expect(rows.filter((row) => owner(row) === B).some(touched)).toBe(false);
  });

  it("deletes only the person's own rows", async () => {
    await forUser(db, A).delete(table);
    expect(await ownersOf(table)).toEqual(Array(seeded.length).fill(B));
  });

  if (key in USER_TABLES) {
    it("refuses to write rows for someone else", () => {
      const row = { ...ownedRows(B).find((r) => r.key === key)!.row };
      expect(() => forUser(db, A).insert(table as never, row as never)).toThrow(ScopeError);
      expect(() => forUser(db, A).update(table, { userId: B } as never)).toThrow(ScopeError);
    });
  }
});

describe("forUser", () => {
  it("needs a user id", () => {
    expect(() => forUser(db, "")).toThrow(ScopeError);
  });

  it("narrows further with a caller's condition, never widens", async () => {
    const mine = await forUser(db, A).select(s.fhirResource, eq(s.fhirResource.fhirId, "obs-1"));
    expect(mine.map((r) => r.userId)).toEqual([A]);
    const theirs = await forUser(db, A).select(s.fhirResource, eq(s.fhirResource.id, `${B}-resource`));
    expect(theirs).toEqual([]);
  });

  it("doesn't move a cursor to someone else's source", () => {
    expect(() => forUser(db, A).update(s.syncCursor, { sourceId: `${B}-source` })).toThrow(ScopeError);
  });

  it("writes the person's own rows", async () => {
    await forUser(db, A).insert(s.auditEvent, { userId: A, action: "export" });
    expect((await forUser(db, A).select(s.auditEvent)).map((r) => r.action).sort()).toEqual(["connect", "export"]);
  });

  it("keeps the table names the sealed values are bound to", () => {
    expect(Object.values(USER_TABLES).map(getTableName)).toContain("fhir_resource");
  });
});
