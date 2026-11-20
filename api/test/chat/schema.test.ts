import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The chat database holds only what spans conversations: no records, tokens or accounts to reach,
// and no conversation content (that lives in each conversation's Durable Object).
describe("chat database", () => {
  const db = env.CHAT_DB!;

  it("has exactly the cross-conversation tables", async () => {
    const { results } = await db.prepare("select name from sqlite_master where type = 'table' and name not like '\\_%' escape '\\' and name not like 'sqlite_%' and name != 'd1_migrations' order by name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["chat_conversation", "chat_run", "summary_evidence", "user_summary"]);
  });

  it("deletes a summary's evidence with it", async () => {
    await db.prepare("insert into user_summary (id, owner_id, idempotency_key, title, content) values ('s1', 'u', 'k', 't', '{}')").run();
    await db.prepare("insert into summary_evidence (id, owner_id, summary_id, kind, target_id, version, position) values ('e1', 'u', 's1', 'record', 'r', 'v', 0)").run();
    await db.prepare("delete from user_summary where id = 's1'").run();
    expect((await db.prepare("select count(*) as n from summary_evidence").first<{ n: number }>())!.n).toBe(0);
  });
});
