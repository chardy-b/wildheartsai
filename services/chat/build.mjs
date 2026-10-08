import { build } from "esbuild";
import { fileURLToPath } from "node:url";

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
  alias: {
    "server-only": "./src/server-only.ts",
    // Resolve this shared static module before packages:external can treat @/ as a package.
    "@/lib/fhir/categories": fileURLToPath(new URL("../../src/lib/fhir/categories.ts", import.meta.url)),
  },
  logLevel: "info",
});
