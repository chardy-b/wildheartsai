import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests run inside workerd (the Workers runtime) with real D1 and R2 bindings from Miniflare,
// one project per Worker so each sees only its own bindings, as in production.

// A throwaway signing key per test run, so Epic client assertions can be made and checked.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const testJwk = JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "test-run-key" });

// Made-up secrets for tests only; real values live in `wrangler secret put` per environment.
const testSecrets = {
  BETTER_AUTH_SECRET: "test-only-secret-not-used-anywhere-else-000",
  BETTER_AUTH_URL: "http://localhost:3000",
  EMAIL_FROM: "Wild Hearts Health <no-reply@example.test>",
  SIGNUPS_ENABLED: "true",
  EPIC_CLIENT_ID: "test-client",
  EPIC_REDIRECT_URI: "http://localhost:3000/api/epic/callback",
  EPIC_PRIVATE_JWK: testJwk,
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  RECORDS_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
};
export default defineConfig(async () => {
  const [mainMigrations, chatMigrations] = await Promise.all([readD1Migrations("migrations"), readD1Migrations("chat-migrations")]);
  // Pure modules shared with the Next app (src/lib) are imported through "@/", as in tsconfig.json.
  // Wrangler's bundler reads the tsconfig paths itself.
  const resolve = { alias: { "@": join(import.meta.dirname, "../src"), "server-only": join(import.meta.dirname, "src/server-only.ts") } };
  return {
    resolve,
    test: {
      projects: [
        {
          resolve,
          plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { ...testSecrets, TEST_MIGRATIONS: mainMigrations } } })],
          test: { name: "api", include: ["test/**/*.test.ts"], exclude: ["test/chat/**"], setupFiles: ["./test/setup.ts"] },
        },
        {
          resolve,
          plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.chat.jsonc" }, miniflare: { bindings: { TEST_MIGRATIONS: chatMigrations } } })],
          test: { name: "chat", include: ["test/chat/**/*.test.ts"], setupFiles: ["./test/chat/setup.ts"] },
        },
      ],
    },
  };
});
