// Imports Epic's directory of health systems and clinics (src/lib/epic/brands.ts) into a
// database now, instead of waiting for the daily `refresh-epic-directory` job. Public data only.
//
//   npm run directory:import                      (DATABASE_URL from .env.local: the local database)
//   npm run directory:import -- --confirm         (required for any database that isn't local)
//
// In a deployed environment, sending the `epic/directory.refresh-requested` event from the
// Inngest dashboard does the same.

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL isn't set.");
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && !process.argv.includes("--confirm")) {
    throw new Error(`${host} isn't a local database. Run again with --confirm to import into it.`);
  }

  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { Pool } = await import("pg");
  const schema = await import("@/lib/db/schema");
  const { importEpicDirectory } = await import("@/lib/epic/directory-import");
  type Db = import("@/lib/db/types").Db;

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    console.log(`Importing Epic's directory into ${host}…`);
    const result = await importEpicDirectory(drizzle(pool, { schema }) as unknown as Db);
    console.log(
      result.changed
        ? `Stored ${result.organizations} organizations and ${result.facilities} facilities at ${result.addresses} addresses.`
        : "Unchanged since the last import.",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
