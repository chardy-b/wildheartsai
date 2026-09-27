import { defineConfig } from "drizzle-kit";

// Generates SQL migrations for Cloudflare D1 (SQLite). Apply them with Wrangler:
// `npm run db:migrate:local` for the local database, `npm run db:migrate:remote` for Cloudflare.
export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
