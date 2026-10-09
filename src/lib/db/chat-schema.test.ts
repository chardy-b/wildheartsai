import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createConversation, finalizeWorkerEvent, submitQuestionAndRun } from "@/lib/chat/store";
import { claimNextQueuedRun } from "@/lib/chat/queue";
import { createTestDb, createTestUser } from "@/test/db";
import { asUser } from "./rls";
import { chatConversation, chatMessage, chatRun, summaryEvidence, userDataKey, userSummary } from "./schema";
import type { Db } from "./types";

let db: Db;
let alice: string;
let bob: string;
let aliceConversation: string;
let bobConversation: string;

async function asAppRole<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role rls_app`);
    return work(tx as unknown as Db);
  });
}

async function asChatDataRole<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role rls_chat_data`);
    return work(tx as unknown as Db);
  });
}

async function asQueueRole<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role rls_chat_queue`);
    return work(tx as unknown as Db);
  });
}

beforeAll(async () => {
  db = await createTestDb();
  await db.execute(sql`create role rls_app nologin`);
  await db.execute(sql`grant all on all tables in schema public to rls_app`);
  await db.execute(sql`create role rls_chat_data nologin nobypassrls nosuperuser noinherit`);
  await db.execute(sql`grant usage on schema public to rls_chat_data`);
  await db.execute(sql`grant select on user_data_key, health_source, fhir_resource, fhir_attachment to rls_chat_data`);
  await db.execute(sql`grant insert (user_id, sealed_dek, kek_version, created_at) on user_data_key to rls_chat_data`);
  await db.execute(sql`grant select (id, user_id, expires_at) on session to rls_chat_data`);
  await db.execute(sql`grant select (id, email_verified) on "user" to rls_chat_data`);
  await db.execute(sql`grant select, insert, update, delete on chat_conversation, chat_message, chat_run, chat_tool_call, chat_event, user_summary, summary_evidence to rls_chat_data`);
  await db.execute(sql`create role rls_chat_queue nologin nobypassrls nosuperuser noinherit`);
  await db.execute(sql`grant usage on schema public to rls_chat_queue`);
  await db.execute(sql`grant select (id, user_id, conversation_id, status, next_attempt_at, lease_owner, lease_expires_at, cancellation_requested_at, attempt, created_at) on chat_run to rls_chat_queue`);
  await db.execute(sql`grant update (status, lease_owner, lease_expires_at, attempt, next_worker_sequence, started_at, completed_at, updated_at) on chat_run to rls_chat_queue`);
  await db.execute(sql`create policy rls_test_queue_select on chat_run for select to rls_chat_queue using (true)`);
  await db.execute(sql`create policy rls_test_queue_update on chat_run for update to rls_chat_queue using (true) with check (true)`);
  alice = await createTestUser(db, "chat_alice");
  bob = await createTestUser(db, "chat_bob");
  aliceConversation = (
    await asAppRole((tx) => asUser(tx, alice, (u) => u.insert(chatConversation).values({ userId: alice, sealedTitle: "v2.a" }).returning({ id: chatConversation.id })))
  )[0].id;
  bobConversation = (
    await asAppRole((tx) => asUser(tx, bob, (u) => u.insert(chatConversation).values({ userId: bob, sealedTitle: "v2.b" }).returning({ id: chatConversation.id })))
  )[0].id;
});

describe("chat storage RLS and ownership", () => {
  it("fails closed when no user context is present", async () => {
    const rows = await asAppRole((tx) => tx.select().from(chatConversation));
    expect(rows).toEqual([]);
  });

  it("permits only the data role's scoped chat/key work and cannot read authentication secrets", async () => {
    const rows = await asChatDataRole((tx) => asUser(tx, alice, (u) => u.select().from(chatConversation)));
    expect(rows.map((row) => row.id)).toEqual([aliceConversation]);

    await expect(asChatDataRole((tx) => tx.execute(sql`select token from session limit 1`))).rejects.toThrow();
    await expect(asChatDataRole((tx) => tx.execute(sql`select access_token, refresh_token, password from account limit 1`))).rejects.toThrow();
    await expect(asChatDataRole((tx) => tx.execute(sql`select sealed_access_token from epic_connection limit 1`))).rejects.toThrow();
  });

  it("lets constrained roles create a first key and chat run, while the queue sees only lease metadata", async () => {
    const conversation = await asChatDataRole((tx) => createConversation(tx, { userId: alice }, { title: "New chat" }));
    const submitted = await asChatDataRole((tx) =>
      submitQuestionAndRun(tx, { userId: alice, conversationId: conversation.id }, { message: "Hello", idempotencyKey: "restricted-role-run" }),
    );
    expect(submitted.duplicate).toBe(false);
    const duplicate = await asChatDataRole((tx) =>
      submitQuestionAndRun(tx, { userId: alice, conversationId: conversation.id }, { message: "Hello", idempotencyKey: "restricted-role-run" }),
    );
    expect(duplicate).toMatchObject({ duplicate: true, run: { id: submitted.run.id }, message: { id: submitted.message.id } });
    const keys = await asChatDataRole((tx) =>
      asUser(tx, alice, (u) => u.select({ userId: userDataKey.userId }).from(userDataKey).where(eq(userDataKey.userId, alice))),
    );
    expect(keys).toHaveLength(1);

    const claimed = await asQueueRole((tx) => claimNextQueuedRun(tx, { workerId: "test-worker", leaseMs: 60_000 }));
    expect(claimed?.scope).toMatchObject({ userId: alice, conversationId: conversation.id, runId: submitted.run.id, runAttempt: 1, workerId: "test-worker" });
    const [row] = await db.select({ nextWorkerSequence: chatRun.nextWorkerSequence }).from(chatRun).where(eq(chatRun.id, submitted.run.id));
    expect(row.nextWorkerSequence).toBe(0);

    await expect(asQueueRole((tx) => tx.execute(sql`select sealed_content from chat_message limit 1`))).rejects.toThrow();
    await expect(asQueueRole((tx) => tx.execute(sql`select sealed_dek from user_data_key limit 1`))).rejects.toThrow();

    const event = { eventId: randomUUID(), sequence: 1, type: "completed" as const, data: {} };
    const finished = await asChatDataRole((tx) => finalizeWorkerEvent(tx, claimed!.scope, { event, status: "completed", assistantContent: "Done" }));
    expect(finished.status).toBe("completed");
    const replayed = await asChatDataRole((tx) => finalizeWorkerEvent(tx, claimed!.scope, { event, status: "completed", assistantContent: "Done" }));
    expect(replayed.id).toBe(finished.id);
  });

  it("replays the same request but rejects a second active question without an orphaned message", async () => {
    const conversation = await asChatDataRole((tx) => createConversation(tx, { userId: alice }, { title: "Single active turn" }));
    const first = await asChatDataRole((tx) =>
      submitQuestionAndRun(tx, { userId: alice, conversationId: conversation.id }, { message: "First question", idempotencyKey: "single-active-first" }),
    );
    const replay = await asChatDataRole((tx) =>
      submitQuestionAndRun(tx, { userId: alice, conversationId: conversation.id }, { message: "First question", idempotencyKey: "single-active-first" }),
    );
    expect(replay).toMatchObject({ duplicate: true, run: { id: first.run.id }, message: { id: first.message.id } });

    await expect(
      asChatDataRole((tx) =>
        submitQuestionAndRun(tx, { userId: alice, conversationId: conversation.id }, { message: "Second question", idempotencyKey: "single-active-second" }),
      ),
    ).rejects.toMatchObject({ code: "CHAT_RUN_BUSY" });

    const messages = await asChatDataRole((tx) =>
      asUser(tx, alice, (u) => u.select({ id: chatMessage.id }).from(chatMessage).where(eq(chatMessage.conversationId, conversation.id))),
    );
    const runs = await asChatDataRole((tx) =>
      asUser(tx, alice, (u) => u.select({ id: chatRun.id }).from(chatRun).where(eq(chatRun.conversationId, conversation.id))),
    );
    expect(messages).toEqual([{ id: first.message.id }]);
    expect(runs).toEqual([{ id: first.run.id }]);
  });

  it("does not reveal another person's conversation", async () => {
    const rows = await asAppRole((tx) => asUser(tx, alice, (u) => u.select().from(chatConversation)));
    expect(rows.map((row) => row.id)).toContain(aliceConversation);
    expect(rows.map((row) => row.id)).not.toContain(bobConversation);
  });

  it("rejects a message whose conversation belongs to another person", async () => {
    await expect(
      asAppRole((tx) =>
        asUser(tx, alice, (u) =>
          u.insert(chatMessage).values({
            userId: alice,
            conversationId: bobConversation,
            sequence: 1,
            role: "user",
            status: "completed",
            sealedContent: "v2.x",
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects a run whose parent message belongs to another conversation", async () => {
    const [message] = await asAppRole((tx) =>
      asUser(tx, alice, (u) =>
        u
          .insert(chatMessage)
          .values({ userId: alice, conversationId: aliceConversation, sequence: 1, role: "user", status: "completed", sealedContent: "v2.x" })
          .returning({ id: chatMessage.id }),
      ),
    );
    await expect(
      asAppRole((tx) =>
        asUser(tx, bob, (u) =>
          u.insert(chatRun).values({ userId: bob, conversationId: bobConversation, parentMessageId: message.id, idempotencyKey: "wrong-parent" }),
        ),
      ),
    ).rejects.toThrow();
  });

  it("keeps evidence descriptors when a linked source target is removed", async () => {
    const [summary] = await asAppRole((tx) =>
      asUser(tx, alice, (u) =>
        u
          .insert(userSummary)
          .values({ userId: alice, idempotencyKey: "summary-evidence", sealedTitle: "v2.t", sealedContent: "v2.c" })
          .returning({ id: userSummary.id }),
      ),
    );
    await asAppRole((tx) =>
      asUser(tx, alice, (u) =>
        u.insert(summaryEvidence).values({ userId: alice, summaryId: summary.id, kind: "record", sealedReference: "v2.reference" }),
      ),
    );
    const rows = await asAppRole((tx) => asUser(tx, alice, (u) => u.select().from(summaryEvidence).where(eq(summaryEvidence.summaryId, summary.id))));
    expect(rows).toHaveLength(1);
    expect(rows[0].recordId).toBeNull();
  });
});
