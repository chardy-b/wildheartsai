import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  const { env } = await import("@/lib/env");
  const config = env();
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.DATABASE_URL).hostname);
  if (!local && !process.argv.includes("--allow-remote")) throw new Error("Remote seeding is disabled. Choose the intended database explicitly and pass --allow-remote.");
  if (!local && (!process.env.DEMO_EMAIL || !process.env.DEMO_PASSWORD)) throw new Error("A hosted demo requires DEMO_EMAIL and a private DEMO_PASSWORD.");
  const email = process.env.DEMO_EMAIL ?? "demo@wildhearts.localhost";
  const password = process.env.DEMO_PASSWORD ?? "demo-local-password";
  if (password.length < 12) throw new Error("Use a demo password of at least 12 characters.");
  const { z } = await import("zod"); z.email().parse(email);
  const { hashPassword } = await import("better-auth/crypto");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { Pool } = await import("pg");
  const schema = await import("@/lib/db/schema");
  const { keyFromBase64 } = await import("@/lib/crypto/seal");
  const { provisionDemo } = await import("@/lib/demo/provision");
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
  try {
    const db = drizzle(pool, { schema }) as unknown as import("@/lib/db/types").Db;
    await provisionDemo(db, keyFromBase64(config.RECORDS_ENCRYPTION_KEY), { email, passwordHash: await hashPassword(password) });
    console.log("Fictional demo ready. Set DEMO_ENABLED=1 on the web server, then sign in with the configured demo account.");
    if (local && !process.env.DEMO_EMAIL && !process.env.DEMO_PASSWORD) console.log("Local-only sign-in: demo@wildhearts.localhost / demo-local-password");
  } finally { await pool.end(); }
}
main().catch(() => { console.error("Demo setup failed. Check the selected database, migrations, email ownership and password settings. No credentials or record contents were logged."); process.exitCode = 1; });
