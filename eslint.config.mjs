import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "services/chat/dist/**",
    "scripts/chat-acceptance/dist/**",
    ".extraction-private/**",
    "next-env.d.ts",
    "api/.wrangler/**",
  ]),
  {
    // The API Worker has no row-level security: only the data layer (forUser, system) and jobs
    // may touch tables. Routes go through src/data. See api/src/data/scope.ts.
    files: ["api/src/**/*.ts"],
    ignores: ["api/src/data/**", "api/src/db/**", "api/src/jobs/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/db/schema", "**/db/schema/*", "**/db/chat/schema", "drizzle-orm/d1"],
          message: "Read and write a person's data through src/data (forUser), not tables directly.",
        }],
      }],
    },
  },
]);

export default eslintConfig;
