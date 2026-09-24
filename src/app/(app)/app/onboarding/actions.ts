"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { acknowledgeSchema, CONSENT_VERSION, nameSchema } from "@/lib/onboarding";
import { completeOnboarding, recordAcknowledgement, savePreferredName } from "@/lib/profile";
import { requireSession } from "@/lib/session";

export type FormState = { error?: string };

export async function saveNameAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireSession();
  const parsed = nameSchema.safeParse({ preferredName: String(formData.get("preferredName") ?? "") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  await savePreferredName(db, session.user.id, parsed.data.preferredName, new Date());
  redirect("/app/onboarding");
}

export async function acknowledgeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireSession();
  const parsed = acknowledgeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  await recordAcknowledgement(db, session.user.id, CONSENT_VERSION, new Date());
  redirect("/app/onboarding");
}

export async function finishOnboardingAction(): Promise<FormState> {
  const session = await requireSession();
  await completeOnboarding(db, session.user.id, new Date());
  redirect("/app");
}
