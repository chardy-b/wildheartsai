import { defineConfig } from "drizzle-kit";

// Generates SQL only; `wrangler d1 migrations apply DB` applies it (see package.json).
export default defineConfig({ dialect: "sqlite", schema: "./src/db/schema/index.ts", out: "./migrations" });
