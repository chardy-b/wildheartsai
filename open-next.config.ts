import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// The Next app on Cloudflare Workers (the web Worker; wrangler.jsonc). No incremental cache:
// every page renders per request (each needs its own CSP nonce; src/app/layout.tsx).
const config = {
  ...defineCloudflareConfig({}),
  // `next build`, then add the files the proxy's bundle needs to its trace
  // (scripts/cloudflare-trace-fix.mjs). Vercel's build is unchanged.
  buildCommand: "npm run build && node scripts/cloudflare-trace-fix.mjs",
};

export default config;
