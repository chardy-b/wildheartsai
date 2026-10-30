import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The chat database holds only chat tables (no records, tokens or accounts to reach).
describe("chat database", () => {
  const db = env.CHAT_DB!;

  it("has exactly the chat tables", async () => {
    const { results } = await db.prepare("select name from sqlite_master where type = 'table' and name not like '\\_%' escape '\\' and name not like 'sqlite_%' and name != 'd1_migrations' order by name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["chat_conversation", "chat_coordinator", "chat_event", "chat_message", "chat_run", "chat_tool_call", "summary_evidence", "user_summary"]);
  });

  it("keeps the evidence kind check", async () => {
    await db.prepare("insert into user_summary (id, user_id, idempotency_key, sealed_title, sealed_content) values ('s1', 'u', 'k', 't', 'c')").run();
    const insert = (kind: string, record: string | null, attachment: string | null) =>
      db.prepare("insert into summary_evidence (id, user_id, summary_id, kind, record_id, attachment_id, sealed_reference) values (?, 'u', 's1', ?, ?, ?, 'r')").bind(crypto.randomUUID(), kind, record, attachment).run();
    await insert("record", "rec", null);
    await insert("note", null, "att");
    await expect(insert("record", "rec", "att")).rejects.toThrow();
  });

  it("ties a message to its owner's conversation", async () => {
    await db.prepare("insert into chat_conversation (id, user_id) values ('c1', 'owner')").run();
    const insert = (user: string) =>
      db.prepare("insert into chat_message (id, user_id, conversation_id, sequence, role, status, sealed_content) values (?, ?, 'c1', ?, 'user', 'completed', 'x')").bind(crypto.randomUUID(), user, Math.floor(Math.random() * 1e9)).run();
    await insert("owner");
    await expect(insert("someone-else")).rejects.toThrow();
  });
});
