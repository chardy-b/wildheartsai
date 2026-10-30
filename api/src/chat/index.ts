// The chat Worker (Phase 6): serves /api/chat/* and the run reaper, with its own D1 database
// (CHAT_DB) and no binding to the main one. Until then it only exposes its database for
// migrations and tests, and answers nothing.
export type ChatBindings = { CHAT_DB: D1Database };

export default {
  fetch: () => Response.json({ error: "not_found" }, { status: 404 }),
} satisfies ExportedHandler<ChatBindings>;
