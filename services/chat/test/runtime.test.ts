import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { it, expect } from "vitest";
import * as schema from "../../../src/lib/db/schema.js";
import type { Db } from "../../../src/lib/db/types.js";
import { mintChatTicket } from "../../../src/lib/chat-auth/ticket.js";
import { createRepository } from "../src/runtime.js";
import { assertChatDatabaseRoles } from "../src/role-preflight.js";
import { createChatHttpServer } from "../src/http.js";
import { createPrivateToolGateway } from "../src/private-gateway.js";
import { JwtCapabilityVerifier, mintRunnerCapability } from "../src/capabilities.js";
import { IggyRunDispatcher } from "../src/dispatcher.js";

async function fixture() {
  const client = new PGlite();
  const raw = drizzle(client, { schema });
  await migrate(raw, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
  const provisioning = await readFile(new URL("../../../scripts/provision-chat-roles.sql", import.meta.url), "utf8");
  await client.exec(provisioning.slice(provisioning.indexOf("BEGIN;")).replace(/PASSWORD :'chat_(data|queue)_password'/g, ""));
  const db = raw as unknown as Db;
  const now = new Date();
  await db.insert(schema.user).values(["a", "b"].map((id) => ({ id, name: "Synthetic person", email: `${id}@example.com`, emailVerified: true, createdAt: now, updatedAt: now })));
  // Every repository operation starts its role inside the transaction, like two
  // separate production pools. This exercises real PostgreSQL grants and RLS.
  const roleDb = (role: "wildhearts_chat_data" | "wildhearts_chat_queue") => new Proxy(db, { get(target, prop) {
    if (prop === "transaction") return (work: (tx: Db) => Promise<unknown>) => target.transaction(async (tx) => { await tx.execute(`SET LOCAL ROLE ${role}`); return work(tx as unknown as Db); });
    return Reflect.get(target, prop);
  } });
  const roleClient = (role: string) => ({ query: (text: string, values?: unknown[]) => client.transaction(async (tx) => { await tx.exec(`SET LOCAL ROLE ${role}`); return tx.query<Record<string, unknown>>(text, values); }) });
  const repository = createRepository(roleDb("wildhearts_chat_data"), roleDb("wildhearts_chat_queue"));
  return { client, db, repository, data: roleClient("wildhearts_chat_data"), queue: roleClient("wildhearts_chat_queue") };
}

it("uses the concrete constrained-role adapter for HTTP idempotency, encrypted tool audit, terminal replay and ownership", async () => {
  const { client, repository, data, queue } = await fixture();
  const key = new TextEncoder().encode("synthetic-32-byte-key-for-test-only");
  let active = true;
  const verifier = new JwtCapabilityVerifier(key, "wildhearts-web", async () => active);
  const ticket = (user: string) => mintChatTicket({ userId: user, sessionId: `session-${user}` }, new TextDecoder().decode(key));
  const publicServer = createChatHttpServer({ repository, verifier, webOrigin: "https://example.com" });
  const privateServer = createPrivateToolGateway({ repository, runnerKey: key, issuer: "synthetic-service", modelId: "synthetic-model" });
  publicServer.listen(0, "127.0.0.1"); privateServer.listen(0, "127.0.0.1");
  await Promise.all([once(publicServer, "listening"), once(privateServer, "listening")]);
  const publicUrl = `http://127.0.0.1:${(publicServer.address() as AddressInfo).port}`;
  const privateUrl = `http://127.0.0.1:${(privateServer.address() as AddressInfo).port}`;
  const authA = { authorization: `Bearer ${await ticket("a")}`, "content-type": "application/json" };
  try {
    await expect(assertChatDatabaseRoles(data, queue)).resolves.toBeUndefined();
    const created = await fetch(`${publicUrl}/v1/conversations`, { method: "POST", headers: authA });
    expect(created.status).toBe(201);
    const { conversation } = await created.json() as { conversation: { id: string } };
    const headers = { ...authA, "idempotency-key": randomUUID() };
    const submit = () => fetch(`${publicUrl}/v1/conversations/${conversation.id}/runs`, { method: "POST", headers, body: JSON.stringify({ message: "Synthetic question, safe for fixture" }) });
    const first = await (await submit()).json() as { runId: string; created: boolean };
    const duplicate = await (await submit()).json() as { runId: string; created: boolean };
    expect(first.created).toBe(true); expect(duplicate).toMatchObject({ runId: first.runId, created: false });
    const busy = await fetch(`${publicUrl}/v1/conversations/${conversation.id}/runs`, { method: "POST", headers: { ...authA, "idempotency-key": randomUUID() }, body: JSON.stringify({ message: "Another concurrent synthetic question" }) });
    expect(busy.status).toBe(409);
    const run = await repository.claimNextRun("worker-test", 30_000); expect(run?.id).toBe(first.runId);
    const scope = run!.scope;
    const capability = await mintRunnerCapability(scope, key, "synthetic-service", run!.attempt, run!.leaseOwner);
    const runnerHeaders = { authorization: `Bearer ${capability}`, "content-type": "application/json" };
    const tool = () => fetch(`${privateUrl}/v1/tools`, { method: "POST", headers: runnerHeaders, body: JSON.stringify({ toolCallId: "call_provider_1", tool: "get_data_coverage", input: {} }) });
    const result = await tool(); expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ status: "completed", output: { coverage: "none" } });
    expect((await tool()).status).toBe(200);
    const trace = await client.query<{ sealed_arguments: string; sealed_result: string }>("select sealed_arguments,sealed_result from chat_tool_call");
    expect(trace.rows).toHaveLength(1); expect(trace.rows[0].sealed_result).not.toContain("coverage");
    const event = { eventId: randomUUID(), sequence: 1, type: "completed", data: { answer: "Synthetic persisted answer" } };
    const complete = () => fetch(`${privateUrl}/v1/worker/events`, { method: "POST", headers: runnerHeaders, body: JSON.stringify(event) });
    expect((await complete()).status).toBe(202); expect((await complete()).status).toBe(202);
    const detail = await (await fetch(`${publicUrl}/v1/conversations/${conversation.id}`, { headers: authA })).json() as { messages: Array<{ role: string; content: string }> };
    expect(detail.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(detail.messages.filter((m) => m.role === "assistant")).toEqual([expect.objectContaining({ content: "Synthetic persisted answer" })]);
    const wrongUser = await fetch(`${publicUrl}/v1/conversations/${conversation.id}`, { headers: { authorization: `Bearer ${await ticket("b")}` } }); expect(wrongUser.status).toBe(404);
    expect((await fetch(`${privateUrl}/v1/worker/context`, { headers: runnerHeaders })).status).toBe(409);
    active = false; expect((await fetch(`${publicUrl}/v1/conversations`, { headers: authA })).status).toBe(401);
    await client.exec("DROP POLICY queue_metadata_update ON chat_run");
    await expect(assertChatDatabaseRoles(data, queue)).rejects.toThrow("queue_policy_not_provisioned");
    await client.exec("CREATE POLICY queue_metadata_update ON chat_run FOR UPDATE TO wildhearts_chat_queue USING (true) WITH CHECK (true)");
    // A bad deployment cannot quietly give queue code transcript, key, or auth access.
    await client.exec("GRANT SELECT (sealed_dek) ON user_data_key TO wildhearts_chat_queue");
    await expect(assertChatDatabaseRoles(data, queue)).rejects.toThrow("chat_role_excess_column_grant");
    await client.exec("REVOKE SELECT (sealed_dek) ON user_data_key FROM wildhearts_chat_queue; GRANT SELECT (token) ON session TO wildhearts_chat_queue");
    await expect(assertChatDatabaseRoles(data, queue)).rejects.toThrow("chat_role_excess_column_grant");
    await client.exec("REVOKE SELECT (token) ON session FROM wildhearts_chat_queue; DROP POLICY chat_data_context_resource ON fhir_resource");
    await expect(assertChatDatabaseRoles(data, queue)).rejects.toThrow("chat_record_policy_not_restricted");
  } finally { publicServer.close(); privateServer.close(); await Promise.all([once(publicServer, "close"), once(privateServer, "close")]); await client.close(); }
});

it("durably cancels a run when cancellation races Iggy provisioning", async () => {
  const { client, repository } = await fixture();
  const basic = { userId: "a", credentialId: "synthetic-ticket", expiresAt: new Date(Date.now() + 60_000) };
  try {
    const conversation = await repository.createConversation(basic);
    const scope = { ...basic, conversationId: conversation.id };
    const run = await repository.createRun({ scope, idempotencyKey: randomUUID(), message: "Synthetic provisioning cancellation" });
    let cancelled = false;
    const dispatcher = new IggyRunDispatcher(repository, {
      startHealthRun: async () => { await repository.requestCancellation({ ...scope, runId: run.runId }); },
      cancelHealthRun: async () => { cancelled = true; },
      getHealthRunStatus: async () => "failed",
    }, new TextEncoder().encode("synthetic-key-long-enough-for-signing"), "synthetic-service", "test-worker", 3_000);
    await dispatcher.dispatchOnce();
    for (let i = 0; i < 100; i++) {
      if ((await repository.getRun(scope, run.runId))?.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(cancelled).toBe(true);
    expect(await repository.getRun(scope, run.runId)).toMatchObject({ status: "cancelled" });
    expect(await repository.listEvents({ ...scope, runId: run.runId }, 0)).toEqual([expect.objectContaining({ kind: "run.cancelled" })]);
  } finally { await client.close(); }
});

it("interrupts expired work without rerunning and honors queued/running cancellations atomically", async () => {
  const { client, repository } = await fixture();
  const basic = { userId: "a", credentialId: "synthetic-ticket", expiresAt: new Date(Date.now() + 60_000) };
  try {
    const conversation = await repository.createConversation(basic);
    const scope = { ...basic, conversationId: conversation.id };
    const queued = await repository.createRun({ scope, idempotencyKey: randomUUID(), message: "Cancel this synthetic question" });
    expect(await repository.requestCancellation({ ...scope, runId: queued.runId })).toBe(true);
    expect(await repository.claimNextRun("worker-test", 30_000)).toBeNull();
    expect(await repository.getRun(scope, queued.runId)).toMatchObject({ status: "cancelled" });
    const crashed = await repository.createRun({ scope, idempotencyKey: randomUUID(), message: "Synthetic interrupted question" });
    const claimed = await repository.claimNextRun("worker-test", 30_000);
    expect(claimed?.id).toBe(crashed.runId);
    await repository.appendWorkerEvent(claimed!.scope, { eventId: randomUUID(), sequence: 1, type: "answer.delta", data: { text: "Synthetic partial" } });
    await client.query("update chat_run set lease_expires_at=now()-interval '1 second' where id=$1", [crashed.runId]);
    expect(await repository.interruptExpiredRuns()).toBe(1);
    expect(await repository.getRun(scope, crashed.runId)).toMatchObject({ status: "interrupted" });
    expect(await repository.claimNextRun("worker-test", 30_000)).toBeNull();
    const retry = await repository.createRun({ scope, idempotencyKey: randomUUID(), message: "Explicit synthetic retry" });
    const activeRun = await repository.claimNextRun("worker-test", 30_000); expect(activeRun?.id).toBe(retry.runId);
    await repository.requestCancellation(activeRun!.scope);
    await expect(repository.finalizeWorkerEvent(activeRun!.scope, { eventId: randomUUID(), sequence: 1, type: "completed", data: { answer: "Late answer" } }, { status: "completed", answer: "Late answer" })).rejects.toThrow();
    expect(await repository.listEvents(activeRun!.scope, 0)).toHaveLength(0);
    await repository.finalizeServiceEvent(activeRun!.scope, { status: "cancelled" });
    expect(await repository.getRun(scope, retry.runId)).toMatchObject({ status: "cancelled" });
    expect(await repository.listEvents(activeRun!.scope, 0)).toEqual([expect.objectContaining({ kind: "run.cancelled" })]);
    const detail = await repository.getConversation(scope);
    expect(detail?.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
  } finally { await client.close(); }
});
