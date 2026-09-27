// Says whether row-level security (migration 0006, src/lib/db/rls.ts) actually applies to the
// role a database URL connects as. Superusers and BYPASSRLS roles skip RLS entirely, whatever
// the tables say, so this can't be checked by tests: run it against each real database.
//
//   npm run db:check-rls                  (DATABASE_URL from .env.local: the local database)
//   pwsh scripts/migrate-production.ps1   (runs this against production after migrating)

import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
import { RLS_TABLES } from "@/lib/db/rls";

loadEnvConfig(process.cwd());

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL isn't set.");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const role = await client.query<{ name: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    const tables = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1)`,
      [[...RLS_TABLES]],
    );
    const { name, rolsuper, rolbypassrls } = role.rows[0];
    console.log(`Role: ${name}${rolsuper ? " (superuser)" : ""}${rolbypassrls ? " (bypasses RLS)" : ""}`);
    const found = new Map(tables.rows.map((t) => [t.relname, t]));
    let tablesOk = true;
    for (const name of RLS_TABLES) {
      const t = found.get(name);
      const ok = !!t && t.relrowsecurity && t.relforcerowsecurity && t.policies > 0;
      tablesOk &&= ok;
      console.log(`  ${ok ? "ok     " : "MISSING"} ${name}`);
    }
    if (!tablesOk) throw new Error("Some tables don't have RLS turned on. Is the database migrated?");
    if (rolsuper || rolbypassrls) {
      if (["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
        console.log("The local database runs as a superuser, so RLS doesn't apply here. That's expected; tests cover it.");
        return;
      }
      throw new Error(
        `RLS is set up, but ${name} skips it. Connect the app as a role without SUPERUSER or BYPASSRLS ` +
          "(on Neon: create one in the console, grant it the tables, and use its URL for DATABASE_URL).",
      );
    }
    console.log("RLS applies to this role.");
  } finally {
    await client.end();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
