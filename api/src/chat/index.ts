import { expiredConversations, forgetExpiredConversation } from "./data/conversations";
import type { ChatBindings } from "./env";
import { chatRoutes } from "./routes";

// The chat Worker: the browser's chat API, one ChatConversation Durable Object per conversation
// (running Pi durable), and CHAT_DB for what spans conversations. No binding to the main database:
// records come through the API Worker's ChatRecords entrypoint.
export { ChatConversation } from "./conversation";
export type { ChatBindings } from "./env";

export default {
  fetch: chatRoutes.fetch,
  // Hourly: demo conversations past their day go, with everything their objects stored.
  async scheduled(_controller, env) {
    for (const id of await expiredConversations(env)) {
      await env.CONVERSATION.get(env.CONVERSATION.idFromName(id)).destroy();
      await forgetExpiredConversation(env, id);
    }
  },
} satisfies ExportedHandler<ChatBindings>;
