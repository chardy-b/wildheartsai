import { eq } from "drizzle-orm";
import { profile } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

export type Profile = typeof profile.$inferSelect;

export async function getProfile(db: Db, userId: string): Promise<Profile | undefined> {
  const [row] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
  return row;
}

async function upsert(db: Db, userId: string, now: Date, fields: Partial<Profile>) {
  await db
    .insert(profile)
    .values({ userId, ...fields, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: profile.userId, set: { ...fields, updatedAt: now } });
}

export function savePreferredName(db: Db, userId: string, preferredName: string, now: Date) {
  return upsert(db, userId, now, { preferredName });
}

export function recordAcknowledgement(db: Db, userId: string, consentVersion: string, now: Date) {
  return upsert(db, userId, now, { consentVersion, consentedAt: now });
}

export function completeOnboarding(db: Db, userId: string, now: Date) {
  return upsert(db, userId, now, { onboardedAt: now });
}
