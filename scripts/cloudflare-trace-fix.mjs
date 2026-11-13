// Cloudflare build only (run by open-next.config.ts after `next build`). Next traces each server
// entry's files as Node.js would load them; OpenNext then copies those files out of
// .next/standalone and bundles them for workerd, which loads some packages differently. Each
// package below is added to the traces that need it, and to the standalone output, so OpenNext can
// copy and bundle it:
// - @opentelemetry/api's ESM build: Next's tracer requires the package (installed here by other
//   packages); the proxy is bundled with the "module" condition, which resolves to its ESM build.
// - pg-cloudflare: pg loads it when it runs on workerd. The Worker never uses pg (pages reach data
//   through the API on Cloudflare), but the bundler must resolve it.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ADDITIONS = [
  { files: join("node_modules", "@opentelemetry", "api", "build", "esm"), neededBy: "node_modules/@opentelemetry/api/" },
  { files: join("node_modules", "pg-cloudflare"), neededBy: "node_modules/pg/lib/stream.js" },
];

function filesIn(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}

const traces = filesIn(join(".next", "server")).filter((file) => file.endsWith(".nft.json"));
if (!existsSync(join(".next", "standalone"))) throw new Error("No standalone output: run through `opennextjs-cloudflare build`");

for (const { files, neededBy } of ADDITIONS) {
  let patched = 0;
  for (const traceFile of traces) {
    const trace = JSON.parse(readFileSync(traceFile, "utf8"));
    if (!trace.files.some((file) => file.includes(neededBy))) continue;
    const added = filesIn(files).map((file) => relative(dirname(traceFile), file).split("\\").join("/"));
    trace.files = [...new Set([...trace.files, ...added])];
    writeFileSync(traceFile, JSON.stringify(trace));
    patched++;
  }
  cpSync(files, join(".next", "standalone", files), { recursive: true });
  console.log(`[cloudflare] ${files}: added to ${patched} traces`);
}
