import "server-only";
import type { Backend } from "./types";

export type { AppSession, Backend, ConnectChoices, ConnectSettings, SignUpSettings, TimelineView } from "./types";

// WILDHEARTS_BACKEND=api is set only in the web Worker's configuration (wrangler.jsonc). Each
// backend is loaded on first use, so the Worker never evaluates the Postgres code and Vercel never
// loads the Cloudflare one.
export async function backend(): Promise<Backend> {
  return process.env.WILDHEARTS_BACKEND === "api" ? (await import("./api")).apiBackend : (await import("./direct")).directBackend;
}
