import "server-only";
import { after } from "next/server";
import { CHAT_WAKE_SECRET_PATTERN, chatWakeUrl } from "@/lib/chat-wake-protocol";

type Configuration = { url: string; secret: string };

function configuration(source: NodeJS.ProcessEnv): Configuration | null {
  const url = source.CHAT_WAKE_URL;
  const secret = source.CHAT_WAKE_SECRET;
  if (!url && !secret) return null;
  if (!url || !secret || !CHAT_WAKE_SECRET_PATTERN.test(secret)) throw new Error("invalid_chat_wake_config");
  return { url: chatWakeUrl(url).toString(), secret };
}

/** Bounded best-effort delivery; the committed Neon queue remains authoritative. */
export async function notifyChatCoordinator(config: Configuration, fetcher: typeof fetch = fetch): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(config.url, {
        method: "POST", headers: { authorization: `Bearer ${config.secret}` },
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel();
      if (response.status === 204) return true;
    } catch { /* Never log a destination, credential, response body or exception. */ }
  }
  return false;
}

/** Call only after the submission transaction has committed, including queued replays. */
export function scheduleChatWake(): void {
  let config: Configuration | null;
  try { config = configuration(process.env); }
  catch {
    console.warn(JSON.stringify({ event: "chat_wake_failed", code: "invalid_config" }));
    return;
  }
  if (!config) return;
  const destination = config;
  try {
    after(async () => {
      if (!(await notifyChatCoordinator(destination))) {
        console.warn(JSON.stringify({ event: "chat_wake_failed", code: "delivery_failed" }));
      }
    });
  } catch {
    console.warn(JSON.stringify({ event: "chat_wake_failed", code: "scheduling_failed" }));
  }
}
