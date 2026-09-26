import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// Pages are either prerendered at build time (the landing and privacy pages) or rendered
// per request (everything behind sign-in), and nothing uses ISR, so prerendered pages are
// served straight from Workers static assets.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
