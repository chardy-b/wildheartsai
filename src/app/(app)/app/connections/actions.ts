"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { deleteConnection } from "@/lib/epic/connections";
import { requireSession } from "@/lib/session";
import { deleteSource } from "@/lib/sources";
import { requestSyncFor } from "@/lib/sync/server";

// Removes the tokens. Records already imported stay until the person deletes them.
export async function disconnectAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await deleteConnection(db, session.user.id, String(formData.get("connectionId") ?? ""));
  revalidatePath("/app/connections");
  revalidatePath("/app");
}

export async function refreshAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  let outcome: string;
  try {
    outcome = await requestSyncFor(session.user.id, String(formData.get("sourceId") ?? ""), "manual");
  } catch (error) {
    console.error("[sync] queueing failed", error instanceof Error ? error.name : "unknown");
    outcome = "failed";
  }
  revalidatePath("/app");
  redirect(`/app/connections?refresh=${outcome}`);
}

// Deletes the organization and everything stored from it: records, sync history and tokens.
export async function deleteSourceAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await deleteSource(db, session.user.id, String(formData.get("sourceId") ?? ""));
  revalidatePath("/app");
  redirect("/app/connections?deleted=1");
}
