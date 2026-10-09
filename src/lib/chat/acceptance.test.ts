import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { asUser } from "@/lib/db/rls";
import { chatConversation, chatMessage, fhirResource, healthSource, userSummary } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createUserMessage, createConversation, deleteSummary, getConversation, listMessages, listSummaries, saveSummary } from "./store";

let db: Db;
let alice: string;
let bob: string;
let aliceConversation: string;
let bobConversation: string;
let aliceRecord: string;
let bobRecord: string;
const sensitiveText = "Synthetic private health question: potassium is 4.2 mmol/L";

async function restricted<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`set local role chat_acceptance_actor`);
    return work(tx as unknown as Db);
  });
}

beforeAll(async () => {
  db = await createTestDb();
  alice = await createTestUser(db, "chat_acceptance_alice");
  bob = await createTestUser(db, "chat_acceptance_bob");
  await db.execute(sql`create role chat_acceptance_actor nologin nosuperuser nobypassrls`);
  await db.execute(sql`grant all on all tables in schema public to chat_acceptance_actor`);
  aliceConversation = (await restricted(tx => createConversation(tx, { userId: alice }, { title: "Synthetic Alice history" }))).id;
  bobConversation = (await restricted(tx => createConversation(tx, { userId: bob }, { title: "Synthetic Bob history" }))).id;
  for (const person of [alice, bob]) {
    const [source] = await db.insert(healthSource).values({ userId: person, vendor: "epic", fhirBaseUrl: `https://${person}.example/R4`, organizationName: "Synthetic organization", status: "disconnected", lastSyncedAt: new Date(), lastSyncStatus: "partial" }).returning();
    const [record] = await db.insert(fhirResource).values({ userId: person, sourceId: source.id, resourceType: "Observation", fhirId: "synthetic-observation", category: "lab", contentHmac: "synthetic-hmac", sealedResource: "synthetic-unused-ciphertext", sealedSummary: "synthetic-unused-ciphertext", normalizerVersion: 2, firstSeenAt: new Date(), lastSeenAt: new Date() }).returning();
    if (person === alice) aliceRecord = record.id; else bobRecord = record.id;
  }
});

describe("personal chat acceptance", () => {
  it("denies reads without a user and forgets ownership scope after a pooled transaction", async () => {
    expect(await restricted(tx => tx.select().from(chatConversation))).toEqual([]);
    const own = await restricted(tx => asUser(tx, alice, u => u.select({ userId: chatConversation.userId }).from(chatConversation)));
    expect(own).toEqual([{ userId: alice }]);
    expect(await restricted(tx => tx.select().from(chatConversation))).toEqual([]);
    expect(await restricted(tx => getConversation(tx, { userId: alice, conversationId: bobConversation }))).toBeUndefined();
  });
  it("rejects a foreign parent even if a write sets the current user's own user_id", async () => {
    await expect(restricted(tx => asUser(tx, alice, u => u.insert(chatMessage).values({ userId: alice, conversationId: bobConversation, sequence: 999, role: "user", status: "completed", sealedContent: "synthetic" })))).rejects.toThrow();
    await expect(restricted(tx => createUserMessage(tx, { userId: alice, conversationId: bobConversation }, { content: sensitiveText }))).rejects.toThrow();
  });
  it("persists encrypted conversations and messages and authenticates the user and row when decrypting", async () => {
    await restricted(tx => createUserMessage(tx, { userId: alice, conversationId: aliceConversation }, { content: sensitiveText }));
    await restricted(tx => createUserMessage(tx, { userId: bob, conversationId: bobConversation }, { content: "Synthetic Bob private message" }));
    const messages = await restricted(tx => listMessages(tx, { userId: alice, conversationId: aliceConversation }));
    expect(messages.map(message => message.content)).toEqual([sensitiveText]);
    const raw = await db.select().from(chatMessage);
    expect(JSON.stringify(raw)).not.toContain(sensitiveText);
    const aliceRow = raw.find(row => row.userId === alice)!;
    const bobRow = raw.find(row => row.userId === bob)!;
    await db.update(chatMessage).set({ sealedContent: bobRow.sealedContent }).where(eq(chatMessage.id, aliceRow.id));
    await expect(restricted(tx => listMessages(tx, { userId: alice, conversationId: aliceConversation }))).rejects.toThrow();
    await db.update(chatMessage).set({ sealedContent: aliceRow.sealedContent }).where(eq(chatMessage.id, aliceRow.id));
  });
  it("stores structured encrypted personal memory, prevents foreign evidence, and marks deleted evidence stale", async () => {
    const summaryInput = { idempotencyKey: randomUUID(), title: "Synthetic potassium summary", text: sensitiveText, coverageState: "partial" as const, evidence: [{ kind: "record" as const, targetId: aliceRecord }] };
    const summary = await restricted(tx => saveSummary(tx, { userId: alice }, summaryInput));
    expect(summary.content.provenance.runId).toBeNull();
    expect(summary.content.coverage.state).toBe("partial");
    const raw = await db.select().from(userSummary);
    expect(JSON.stringify(raw)).not.toContain(sensitiveText);
    expect(await restricted(tx => listSummaries(tx, { userId: bob }))).toEqual([]);
    expect(await restricted(tx => deleteSummary(tx, { userId: bob }, summary.id))).toBe(false);
    await expect(restricted(tx => saveSummary(tx, { userId: alice }, { ...summaryInput, idempotencyKey: randomUUID(), evidence: [{ kind: "record", targetId: bobRecord }] }))).rejects.toThrow();
    await db.delete(fhirResource).where(eq(fhirResource.id, aliceRecord));
    expect((await restricted(tx => listSummaries(tx, { userId: alice })))[0].freshness).toBe("stale");
    expect(await restricted(tx => deleteSummary(tx, { userId: alice }, summary.id))).toBe(true);
    expect(await restricted(tx => listSummaries(tx, { userId: alice }))).toEqual([]);
  });
});
