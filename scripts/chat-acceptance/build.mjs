import { build } from "../../services/chat/node_modules/esbuild/lib/main.js";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
await build({
  absWorkingDir: root, entryPoints: ["scripts/chat-acceptance/web.ts"], outfile: "scripts/chat-acceptance/dist/web.mjs",
  bundle: true, packages: "external", platform: "node", format: "esm", target: "node22", tsconfig: "tsconfig.json",
  alias: { "server-only": "./src/test/empty.ts", "@/lib/auth": "./scripts/chat-acceptance/auth.ts", "@/lib/env": "./scripts/chat-acceptance/env.ts" },
});
