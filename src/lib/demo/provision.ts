import "server-only";
import { eq } from "drizzle-orm";
import { user, account, profile } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { asUser } from "@/lib/db/rls";
import { CONSENT_VERSION } from "@/lib/onboarding";
import { DEMO_NAME, DEMO_USER_ID } from "./scenario";
import { populateDemo } from "./store";

export async function provisionDemo(db: Db, kek: Buffer, input: { email: string; passwordHash: string; now?: Date }) {
  const now = input.now ?? new Date();
  await db.transaction(async tx => {
    const [existing] = await tx.select().from(user).where(eq(user.id, DEMO_USER_ID));
    const [emailOwner] = await tx.select({ id: user.id }).from(user).where(eq(user.email, input.email));
    if (emailOwner && emailOwner.id !== DEMO_USER_ID) throw new Error("Demo email already belongs to another account; no data changed.");
    if (existing && existing.email !== input.email) throw new Error("The demo identity has a different email; use its original email.");
    await tx.insert(user).values({ id: DEMO_USER_ID, name: `${DEMO_NAME} (fictional demo)`, email: input.email, emailVerified: true, createdAt: now, updatedAt: now }).onConflictDoNothing();
    const [credential] = await tx.select({ id: account.id }).from(account).where(eq(account.id, `${DEMO_USER_ID}_credential`));
    if (!credential) await tx.insert(account).values({ id: `${DEMO_USER_ID}_credential`, accountId: DEMO_USER_ID, providerId: "credential", userId: DEMO_USER_ID, password: input.passwordHash, createdAt: now, updatedAt: now });
    // Re-running the fixture import never silently rotates existing credentials.
    await asUser(tx as unknown as Db, DEMO_USER_ID, async scoped => {
      await scoped.insert(profile).values({ userId: DEMO_USER_ID, preferredName: "Alex (demo)", consentVersion: CONSENT_VERSION, consentedAt: now, onboardedAt: now }).onConflictDoNothing();
    });
  });
  await populateDemo(db, kek, DEMO_USER_ID, { now });
}
