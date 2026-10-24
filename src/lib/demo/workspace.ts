import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/types";
import { session, user, profile } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import { CONSENT_VERSION } from "@/lib/onboarding";
import { DEMO_NAME } from "./scenario";
import { demoUserId, isDemoIdentity } from "./identity";
import { populateDemo } from "./store";

type ParentIdentity = {
  user: { id: string; emailVerified: boolean };
  session: { id: string; expiresAt: Date };
};

const workspaceSessionId = (parentId: string) => `demo_${createHash("sha256").update(parentId).digest("hex")}`;

/** Creates no password, sign-in cookie, or public credential for the workspace. */
export async function ensureDemoWorkspace(db: Db, kek: Buffer, identity: ParentIdentity) {
  if (!identity.user.emailVerified || identity.session.expiresAt <= new Date() || isDemoIdentity(identity.user.id)) throw new Error("demo_login_required");
  const userId = demoUserId(identity.user.id), now = new Date();
  await db.transaction(async tx => {
    const [parent] = await tx.select().from(session).where(and(eq(session.id, identity.session.id), eq(session.userId, identity.user.id))).for("share");
    const [owner] = await tx.select().from(user).where(eq(user.id, identity.user.id));
    if (!parent || parent.parentSessionId || parent.expiresAt <= now || !owner?.emailVerified) throw new Error("demo_login_required");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-workspace:${userId}`}))`);
    await tx.insert(user).values({ id: userId, name: `${DEMO_NAME} (fictional demo)`, email: `${userId.slice(-64)}@demo.invalid`, emailVerified: true, createdAt: now, updatedAt: now }).onConflictDoNothing();
    await asUser(tx as unknown as Db, userId, scoped => scoped.insert(profile).values({ userId, preferredName: "Alex (demo)", consentVersion: CONSENT_VERSION, consentedAt: now, onboardedAt: now }).onConflictDoNothing());
    await tx.insert(session).values({ id: workspaceSessionId(parent.id), userId, parentSessionId: parent.id, token: randomBytes(32).toString("base64url"), expiresAt: parent.expiresAt, createdAt: now, updatedAt: now }).onConflictDoUpdate({ target: session.id, set: { expiresAt: parent.expiresAt, updatedAt: now } });
  });
  await populateDemo(db, kek, userId);
}

/** Resolves only this person's workspace; callers cannot supply an identity. */
export async function selectedDemoSession(db: Db, identity: ParentIdentity) {
  if (!identity.user.emailVerified || identity.session.expiresAt <= new Date() || isDemoIdentity(identity.user.id)) return null;
  const userId = demoUserId(identity.user.id);
  return db.transaction(async tx => {
    const [parent] = await tx.select().from(session).where(and(eq(session.id, identity.session.id), eq(session.userId, identity.user.id))).for("share");
    const [owner] = await tx.select().from(user).where(eq(user.id, identity.user.id));
    if (!parent || parent.parentSessionId || parent.expiresAt <= new Date() || !owner?.emailVerified) return null;
    const [selected] = await tx.select().from(session).where(and(eq(session.id, workspaceSessionId(parent.id)), eq(session.userId, userId), eq(session.parentSessionId, parent.id)));
    const [demoUser] = await tx.select().from(user).where(eq(user.id, userId));
    if (!selected || !demoUser?.emailVerified) return null;
    if (selected.expiresAt.getTime() !== parent.expiresAt.getTime()) {
      await tx.update(session).set({ expiresAt: parent.expiresAt, updatedAt: new Date() }).where(eq(session.id, selected.id));
    }
    return { user: demoUser, session: { ...selected, expiresAt: parent.expiresAt } };
  });
}
