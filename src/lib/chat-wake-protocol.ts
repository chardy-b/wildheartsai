// A content-free hint only. This credential cannot claim work or authorize tools.
export const CHAT_WAKE_PATH = "/internal/chat/wake";
export const CHAT_WAKE_SECRET_PATTERN = /^whwake1\.[A-Za-z0-9_-]{43}$/;

export function chatWakeUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== CHAT_WAKE_PATH) {
    throw new Error("invalid_chat_wake_url");
  }
  return url;
}
