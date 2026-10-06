import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)), "server-only": fileURLToPath(new URL("./src/server-only.ts", import.meta.url)) } }, test: { setupFiles: ["../../src/test/setup.ts"], testTimeout: 30_000 } });
