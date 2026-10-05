import "server-only";

/** A single CSP-safe, canonical API origin shared by tickets and page policy. */
export function chatApiOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^[a-z0-9.-]+$/i.test(url.hostname)) return null;
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return url.origin;
  } catch { return null; }
}

export function chatConfiguration(source: Record<string, string | undefined> = process.env): { apiUrl: string; signingKey: string } | null {
  const apiUrl = chatApiOrigin(source.CHAT_API_URL);
  const signingKey = source.CHAT_SIGNING_KEY;
  if (!apiUrl || !signingKey || Buffer.byteLength(signingKey) < 32) return null;
  return { apiUrl, signingKey };
}
