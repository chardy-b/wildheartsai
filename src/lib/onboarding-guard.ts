import "server-only";
import { redirect } from "next/navigation";
import { backend } from "@/lib/backend";
import { onboardingStep } from "@/lib/onboarding";
import type { Profile } from "@/lib/profile";
import { requireSession, type Session } from "@/lib/session";

export async function requireOnboarded(): Promise<{ session: Session; profile: Profile }> {
  const session = await requireSession();
  const profile = await (await backend()).profile(session.user.id);
  if (!profile || onboardingStep(profile) !== "done") redirect("/app/onboarding");
  return { session, profile };
}
