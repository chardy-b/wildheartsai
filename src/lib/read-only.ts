// Read-only mode for the cutover to Cloudflare (docs/superpowers/plans/2026-11-20-cutover-runbook.md).
// MAINTENANCE_READ_ONLY=1 (and a redeploy) pauses every change while the final copy to D1 runs, so
// nothing written on Vercel is left behind: sign-up, Connect, Refresh, uploads, chat, deletes,
// profile edits and the background jobs. Viewing, signing in and out, and opening stored notes
// still work. Off unless set.

export const READ_ONLY_MESSAGE = "Wild Hearts is moving to new servers. Changes are paused for a few minutes; you can still view your records.";

export function readOnly(): boolean {
  return process.env.MAINTENANCE_READ_ONLY === "1";
}

// For server actions that change data: the proxy refuses them too, but a matcher change or a moved
// action could skip it (see node_modules/next/dist/docs, proxy.md).
export function assertWritable(): void {
  if (readOnly()) throw new Error(READ_ONLY_MESSAGE);
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
// Signing in and out still work; renewing a session writes, but that is lost harmlessly.
const ALWAYS_ALLOWED = [/^\/api\/auth\/sign-in\//, /^\/api\/auth\/sign-out$/, /^\/api\/auth\/get-session$/];
// Connect starts and ends with GETs that store a connection.
const BLOCKED_READS = [/^\/api\/epic\/(authorize|callback)$/];

// What read-only mode does with a request: refuse it as JSON, send Connect back to its page, or let
// it through. Server actions are POSTs to the page using them; the records pages' only action reads
// a note.
export function readOnlyRefusal(method: string, pathname: string, serverAction: boolean): "json" | "redirect" | null {
  if (pathname.startsWith("/api/")) {
    if (BLOCKED_READS.some((r) => r.test(pathname))) return "redirect";
    if (READS.has(method) || ALWAYS_ALLOWED.some((r) => r.test(pathname))) return null;
    return "json";
  }
  if (serverAction && !READS.has(method) && !pathname.startsWith("/app/records")) return "json";
  return null;
}
