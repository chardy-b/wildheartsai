import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";

loadEnvConfig(process.cwd());

// Migrations use Neon's direct connection when Vercel provides one (DATABASE_URL is pooled
// through PgBouncer, which isn't meant for schema changes). Locally only DATABASE_URL is set.
export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "" },
});
