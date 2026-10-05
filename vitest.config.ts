import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test/empty.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // Each database test worker starts an in-process Postgres. Bound simultaneous
    // migrations so larger suites do not time out under local/CI memory pressure.
    maxWorkers: 2,
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
});
