import { defineConfig } from "drizzle-kit";

// The chat database (binding CHAT_DB); applied with `wrangler d1 migrations apply CHAT_DB`.
export default defineConfig({ dialect: "sqlite", schema: "./src/db/chat/schema.ts", out: "./chat-migrations" });
