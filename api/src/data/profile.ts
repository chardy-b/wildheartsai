import { profile } from "../db/schema";
import type { UserScope } from "./scope";

// Ported from src/lib/profile.ts.
export type Profile = typeof profile.$inferSelect;

export async function getProfile(scope: UserScope): Promise<Profile | undefined> {
  const [row] = await scope.select(profile).limit(1);
  return row;
}

function upsert(scope: UserScope, now: Date, fields: Partial<Profile>) {
  return scope
    .insert(profile, { userId: scope.userId, ...fields, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: profile.userId, set: { ...fields, updatedAt: now } });
}

export const savePreferredName = (scope: UserScope, preferredName: string, now: Date) => upsert(scope, now, { preferredName });
export const recordAcknowledgement = (scope: UserScope, consentVersion: string, now: Date) => upsert(scope, now, { consentVersion, consentedAt: now });
export const completeOnboarding = (scope: UserScope, now: Date) => upsert(scope, now, { onboardedAt: now });
