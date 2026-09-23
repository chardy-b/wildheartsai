import "server-only";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { onboardingStep } from "@/lib/onboarding";
import { getProfile, type Profile } from "@/lib/profile";
import { requireSession, type Session } from "@/lib/session";

export async function requireOnboarded(): Promise<{ session: Session; profile: Profile }> {
  const session = await requireSession();
  const profile = await getProfile(db, session.user.id);
  if (!profile || onboardingStep(profile) !== "done") redirect("/app/onboarding");
  return { session, profile };
}
