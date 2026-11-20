import type { ChatRecords } from "../chat-records";
import type { RateLimiter } from "../limits";
import type { ChatConversation } from "./conversation";

// The chat Worker's bindings (api/wrangler.chat.jsonc). It has no binding to the main database or
// R2: records come only through RECORDS, the API Worker's ChatRecords entrypoint.
export type ChatBindings = {
  CHAT_DB: D1Database;
  RECORDS: Service<ChatRecords>;
  CONVERSATION: DurableObjectNamespace<ChatConversation>;
  // The API Worker's limiter, shared so a person's limits are the same wherever they're counted.
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  // "1" turns chat on. Off by default, as on Vercel.
  CHAT_ENABLED?: string;
  // The VPS's edge service (services/chat, CHAT_SERVICE_MODE=edge): the inference relay and the
  // research corpus, behind one token only this Worker holds.
  CHAT_EDGE_URL?: string;
  CHAT_EDGE_TOKEN?: string;
  CHAT_MODEL_ID?: string;
};

export type EdgeConfig = { url: string; token: string; modelId: string };

export function edgeConfig(env: ChatBindings): EdgeConfig | null {
  if (!env.CHAT_EDGE_URL || !env.CHAT_EDGE_TOKEN || !env.CHAT_MODEL_ID) return null;
  return { url: env.CHAT_EDGE_URL.replace(/\/$/, ""), token: env.CHAT_EDGE_TOKEN, modelId: env.CHAT_MODEL_ID };
}

export class ChatRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}
