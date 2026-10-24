import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import { account, healthSource, session, user } from "@/lib/db/schema";
import { findRecords } from "@/lib/chat/gateway";
import { demoUserId, demoModeValue, demoSelected, DEMO_MODE_COOKIE } from "./identity";
import { ensureDemoWorkspace, selectedDemoSession } from "./workspace";
import { demoSnapshot, importDemoDocument, populateDemo } from "./store";

const kek = Buffer.from(process.env.RECORDS_ENCRYPTION_KEY!, "base64");
async function fixture() {
  const db = await createTestDb();
  const ownerId = await createTestUser(db, "workspace_owner");
  const otherId = await createTestUser(db, "workspace_other");
  const expiresAt = new Date(Date.now() + 3600_000), now = new Date();
  for (const userId of [ownerId, otherId]) await db.insert(session).values({ id: `real-${userId}`, userId, token: `synthetic-${userId}`, expiresAt, createdAt: now, updatedAt: now });
  const identity = (id = ownerId) => ({ user: { id, emailVerified: true }, session: { id: `real-${id}`, expiresAt } });
  return { db, ownerId, otherId, identity };
}

describe("demo workspaces behind the person's existing login", () => {
  it("creates isolated fictional charts and no password; the real chat tools query only the selected chart", async () => {
    const f = await fixture();
    await f.db.insert(healthSource).values({ userId: f.ownerId, vendor: "epic", fhirBaseUrl: "https://private.example/FHIR/R4", organizationName: "Personal chart", status: "disconnected" });
    await ensureDemoWorkspace(f.db, kek, f.identity());
    await ensureDemoWorkspace(f.db, kek, f.identity(f.otherId));
    const selected = (await selectedDemoSession(f.db, f.identity()))!;
    expect(selected.user.id).toBe(demoUserId(f.ownerId));
    expect(selected.session.parentSessionId).toBe(f.identity().session.id);
    expect(await f.db.select().from(account).where(eq(account.userId, selected.user.id))).toEqual([]);
    const before = (await demoSnapshot(f.db, kek, selected.user.id))!;
    expect(before.sources).toHaveLength(3);
    expect(before.records).toHaveLength(43);
    await ensureDemoWorkspace(f.db, kek, f.identity());
    expect((await demoSnapshot(f.db, kek, selected.user.id))!.records.map(row => row.id).sort()).toEqual(before.records.map(row => row.id).sort());
    const found = await findRecords(f.db, { userId: selected.user.id }, { query: "Esophageal biopsy peak eosinophils", limit: 20 });
    expect(found.records).toHaveLength(2);
    await importDemoDocument(f.db, kek, selected.user.id);
    const otherDemo = demoUserId(f.otherId);
    expect((await demoSnapshot(f.db, kek, otherDemo))!.records).toHaveLength(43);
    await populateDemo(f.db, kek, selected.user.id, { reset: true });
    expect((await demoSnapshot(f.db, kek, otherDemo))!.records).toHaveLength(43);
    expect(await f.db.select().from(healthSource).where(eq(healthSource.userId, f.ownerId))).toMatchObject([{ organizationName: "Personal chart" }]);
    expect(() => demoSnapshot(f.db, kek, f.ownerId)).toThrow("demo_forbidden");
  });

  it("fences chat work when the real login expires or is deleted, and cannot select another person's workspace", async () => {
    const f = await fixture();
    await ensureDemoWorkspace(f.db, kek, f.identity());
    expect(await selectedDemoSession(f.db, f.identity(f.otherId))).toBeNull();
    expect(await selectedDemoSession(f.db, { ...f.identity(f.otherId), session: f.identity().session })).toBeNull();
    const selected = (await selectedDemoSession(f.db, f.identity()))!;
    const locked = () => f.db.execute(sql`select public.chat_lock_session_v2(${selected.session.id}, ${selected.user.id}) as expires`);
    expect((await locked() as unknown as { rows: { expires: unknown }[] }).rows[0].expires).not.toBeNull();
    await f.db.update(session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(session.id, f.identity().session.id));
    expect(await selectedDemoSession(f.db, f.identity())).toBeNull();
    expect((await locked() as unknown as { rows: { expires: unknown }[] }).rows[0].expires).toBeNull();
    await f.db.delete(session).where(eq(session.id, f.identity().session.id));
    expect(await f.db.select().from(session).where(eq(session.id, selected.session.id))).toEqual([]);
  });

  it("requires a verified, current real login and refuses nested demo sessions", async () => {
    const f = await fixture();
    await expect(ensureDemoWorkspace(f.db, kek, { ...f.identity(), user: { id: f.ownerId, emailVerified: false } })).rejects.toThrow("demo_login_required");
    await f.db.update(user).set({ emailVerified: false }).where(eq(user.id, f.ownerId));
    await expect(ensureDemoWorkspace(f.db, kek, f.identity())).rejects.toThrow("demo_login_required");
    await f.db.update(user).set({ emailVerified: true }).where(eq(user.id, f.ownerId));
    await ensureDemoWorkspace(f.db, kek, f.identity());
    const selected = (await selectedDemoSession(f.db, f.identity()))!;
    await expect(ensureDemoWorkspace(f.db, kek, selected)).rejects.toThrow("demo_login_required");
    await f.db.update(session).set({ parentSessionId: null }).where(and(eq(session.id, selected.session.id), eq(session.userId, selected.user.id)));
    const result = await f.db.execute(sql`select public.chat_lock_session_v2(${selected.session.id}, ${selected.user.id}) as expires`);
    expect((result as unknown as { rows: { expires: unknown }[] }).rows[0].expires).toBeNull();
  });

  it("binds the mode preference to this login without falling back to personal data when demo entry is disabled", () => {
    vi.stubEnv("DEMO_ENABLED", "1");
    try {
      const headers = new Headers({ cookie: `${DEMO_MODE_COOKIE}=${demoModeValue("session-a")}` });
      expect(demoSelected(headers, "session-a")).toBe(true);
      expect(demoSelected(headers, "session-b")).toBe(false);
      expect(demoSelected(new Headers({ cookie: `${DEMO_MODE_COOKIE}=1` }), "session-a")).toBe(false);
      vi.stubEnv("DEMO_ENABLED", "0");
      expect(demoSelected(headers, "session-a")).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
});
