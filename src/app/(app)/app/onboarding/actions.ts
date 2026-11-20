"use server";

import { assertWritable } from "@/lib/read-only";
import { redirect } from "next/navigation";
import { backend } from "@/lib/backend";
import { acknowledgeSchema, nameSchema } from "@/lib/onboarding";
import { requireSession } from "@/lib/session";

export type FormState = { error?: string };

export async function saveNameAction(_prev: FormState, formData: FormData): Promise<FormState> {
  assertWritable();
  const session = await requireSession();
  const parsed = nameSchema.safeParse({ preferredName: String(formData.get("preferredName") ?? "") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  await (await backend()).savePreferredName(session.user.id, parsed.data.preferredName);
  redirect("/app/onboarding");
}

export async function acknowledgeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  assertWritable();
  const session = await requireSession();
  const parsed = acknowledgeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  await (await backend()).recordAcknowledgement(session.user.id);
  redirect("/app/onboarding");
}

export async function finishOnboardingAction(): Promise<FormState> {
  assertWritable();
  const session = await requireSession();
  await (await backend()).completeOnboarding(session.user.id);
  redirect("/app");
}
