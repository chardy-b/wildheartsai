import { applyD1Migrations, env } from "cloudflare:test";

// Each test file gets isolated storage; apply the schema to it.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
