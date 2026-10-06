import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts", "src/worker-entry.ts"],
  outdir: "dist",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  alias: { "server-only": "./src/server-only.ts" },
  logLevel: "info",
});
