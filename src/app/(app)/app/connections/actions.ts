"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { backend } from "@/lib/backend";
import { requireSession } from "@/lib/session";

// Removes the tokens. Records already imported stay until the person deletes them.
export async function disconnectAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await (await backend()).disconnect(session.user.id, String(formData.get("connectionId") ?? ""));
  revalidatePath("/app/connections");
  revalidatePath("/app");
}

export async function refreshAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const outcome = await (await backend()).refresh(session.user.id, String(formData.get("sourceId") ?? ""));
  revalidatePath("/app");
  redirect(`/app/connections?refresh=${outcome}`);
}

// Checks every connected organization for new records.
export async function refreshAllAction(): Promise<void> {
  const session = await requireSession();
  const outcome = await (await backend()).refreshAll(session.user.id);
  revalidatePath("/app");
  redirect(`/app/connections?refresh=${outcome}`);
}

// Deletes the organization and everything stored from it: records, sync history and tokens.
export async function deleteSourceAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await (await backend()).deleteSource(session.user.id, String(formData.get("sourceId") ?? ""));
  revalidatePath("/app");
  redirect("/app/connections?deleted=1");
}

// Connects one of Metriport's sample patients: no sign-in, so it goes straight to importing.
export async function connectMetriportSandboxAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const target = await (await backend()).connectMetriport(session.user.id, String(formData.get("persona") ?? ""));
  revalidatePath("/app");
  revalidatePath("/app/connections");
  redirect(target);
}
