import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_GUEST_COOKIE, DEMO_MODE_COOKIE, demoModeValue } from "@/lib/demo/identity";
import { DEMO_USER_ID } from "@/lib/demo/scenario";
import { ChatRecords } from "../src/chat-records";
import * as records from "../src/data/chat-records";
import { ensureDemoChart, issueGuestViewer } from "../src/data/demo";
import * as s from "../src/db/schema";
import type { Bindings } from "../src/env";
import { clearAll, db, origin, recordsKey, signedIn } from "./helpers";

// The chat Worker's narrow way into the main database. Fictional records only: the demo chart is
// "person A", and a signed-up account is "person B".
const bindings = env as unknown as Bindings;

beforeEach(async () => {
  await clearAll();
  await ensureDemoChart(bindings, db, recordsKey);
});

describe("ChatRecords", () => {
  it("exposes exactly the reviewed methods", () => {
    // A new method fails here until it's added on purpose (and reviewed against the chat spec).
    expect(Object.getOwnPropertyNames(ChatRecords.prototype).filter((name) => name !== "constructor").sort()).toEqual(
      ["dataCoverage", "evidence", "findRecords", "identify", "labTrend", "readRecords", "readStoredNote", "recordSources", "sessionFence"],
    );
  });

  it("identifies logins, demo viewers and guests, and fences each", async () => {
    const { userId, cookie } = await signedIn("b@example.test");
    const me = (await records.identify(bindings, cookie))!;
    expect(me).toMatchObject({ userId, demo: null, fence: { kind: "session", userId } });
    expect(await records.sessionFence(bindings, me.fence)).not.toBeNull();

    const real = (await (await SELF.fetch(`${origin}/api/session?real=1`, { headers: { cookie } })).json()) as { session: { id: string } };
    const viewing = (await records.identify(bindings, `${cookie}; ${DEMO_MODE_COOKIE}=${demoModeValue(real.session.id)}`))!;
    expect(viewing).toMatchObject({ userId: DEMO_USER_ID, demo: { viewer: "member", viewerId: userId }, fence: { kind: "session", userId } });

    const guest = (await records.identify(bindings, `${DEMO_GUEST_COOKIE}=${issueGuestViewer(env.BETTER_AUTH_SECRET!).cookie}`))!;
    expect(guest).toMatchObject({ userId: DEMO_USER_ID, demo: { viewer: "guest" }, fence: { kind: "until" } });
    expect(await records.sessionFence(bindings, guest.fence)).not.toBeNull();
    expect(await records.sessionFence(bindings, { kind: "until", expiresAt: new Date(Date.now() - 1000).toISOString() })).toBeNull();
    expect(await records.identify(bindings, "")).toBeNull();

    // Signing out (the session row goes) or losing verification ends the fence.
    await db.update(s.user).set({ emailVerified: false }).where(eq(s.user.id, userId));
    expect(await records.sessionFence(bindings, me.fence)).toBeNull();
    await db.update(s.user).set({ emailVerified: true }).where(eq(s.user.id, userId));
    await SELF.fetch(`${origin}/api/auth/sign-out`, { method: "POST", headers: { cookie, Origin: origin } });
    expect(await records.sessionFence(bindings, me.fence)).toBeNull();
    expect(await records.identify(bindings, cookie)).toBeNull();
  });

  it("answers the record tools for their owner, with receipts, and nothing for anyone else", async () => {
    const { userId: other } = await signedIn("b@example.test");
    const found = await records.findRecords(bindings, DEMO_USER_ID, { query: "Esophageal biopsy peak eosinophils", limit: 20 });
    expect(found.output.records).toHaveLength(2);
    const ids = found.output.records.map((r) => r.citation.id);
    const stored = await db.select().from(s.fhirResource).where(eq(s.fhirResource.id, ids[0]));
    expect(found.receipts).toContainEqual({ kind: "record", targetId: ids[0], version: stored[0].contentHmac });
    expect((await records.readRecords(bindings, DEMO_USER_ID, { recordIds: ids, includeDetails: true })).output).toHaveLength(2);
    expect((await records.labTrend(bindings, DEMO_USER_ID, { recordIds: ids })).output).toMatchObject({ ok: true, change: -34 });
    const [note] = await db.select().from(s.fhirAttachment).where(eq(s.fhirAttachment.userId, DEMO_USER_ID)).limit(1);
    const read = await records.readStoredNote(bindings, DEMO_USER_ID, { attachmentId: note.id });
    expect(read.output).toMatchObject({ available: true });
    expect((await records.evidence(bindings, DEMO_USER_ID, [{ kind: "record", targetId: ids[0] }, { kind: "note", targetId: note.id }])).map((e) => e.version)).toEqual([stored[0].contentHmac, read.receipts[0].version]);
    expect(await records.recordSources(bindings, DEMO_USER_ID, [...found.receipts, ...read.receipts])).toHaveLength(3);
    expect((await records.dataCoverage(bindings, DEMO_USER_ID)).output.sources).toHaveLength(4);

    // Person B asking with A's handles gets nothing.
    expect((await records.findRecords(bindings, other, { query: "eosinophils" })).output.records).toEqual([]);
    expect((await records.readRecords(bindings, other, { recordIds: ids })).output).toEqual([]);
    expect((await records.labTrend(bindings, other, { recordIds: ids })).output).toMatchObject({ ok: false });
    expect((await records.readStoredNote(bindings, other, { attachmentId: note.id })).output).toEqual({ available: false, reason: "not_found" });
    expect((await records.evidence(bindings, other, [{ kind: "record", targetId: ids[0] }])).map((e) => e.version)).toEqual([null]);
    expect(await records.recordSources(bindings, other, found.receipts)).toEqual([]);
    expect((await records.dataCoverage(bindings, other)).output).toMatchObject({ sources: [], categories: [], coverage: "none" });
  });

  it("refuses tool input the schemas don't allow, before reading anything", async () => {
    await expect(records.findRecords(bindings, DEMO_USER_ID, { userId: "someone-else" })).rejects.toThrow();
    await expect(records.readRecords(bindings, DEMO_USER_ID, { recordIds: ["not-a-uuid"] })).rejects.toThrow();
    await expect(records.readRecords(bindings, DEMO_USER_ID, { recordIds: Array.from({ length: 21 }, () => crypto.randomUUID()) })).rejects.toThrow();
  });

  it("never answers with secrets: no session tokens, sealed fields or account data", async () => {
    const { cookie } = await signedIn("b@example.test");
    const [token] = await db.select({ token: s.session.token }).from(s.session);
    const found = await records.findRecords(bindings, DEMO_USER_ID, { limit: 20 });
    const answers = JSON.stringify([
      await records.identify(bindings, cookie), found, await records.dataCoverage(bindings, DEMO_USER_ID),
      await records.recordSources(bindings, DEMO_USER_ID, found.receipts.slice(0, 5)),
      await records.evidence(bindings, DEMO_USER_ID, found.receipts.slice(0, 5)),
    ]);
    expect(answers).not.toContain(token.token);
    expect(answers).not.toMatch(/sealed|password|accessToken|refreshToken|"token"/i);
  });
});
