import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd (the Workers runtime) with real D1 and R2 bindings from Miniflare,
// one project per Worker so each sees only its own bindings, as in production.
export default defineConfig(async () => {
  const [mainMigrations, chatMigrations] = await Promise.all([readD1Migrations("migrations"), readD1Migrations("chat-migrations")]);
  return {
    test: {
      projects: [
        {
          plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { TEST_MIGRATIONS: mainMigrations } } })],
          test: { name: "api", include: ["test/**/*.test.ts"], exclude: ["test/chat/**"], setupFiles: ["./test/setup.ts"] },
        },
        {
          plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.chat.jsonc" }, miniflare: { bindings: { TEST_MIGRATIONS: chatMigrations } } })],
          test: { name: "chat", include: ["test/chat/**/*.test.ts"], setupFiles: ["./test/chat/setup.ts"] },
        },
      ],
    },
  };
});
