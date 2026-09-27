"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { asUser } from "@/lib/db/rls";
import { deleteConnection } from "@/lib/epic/connections";
import { requireSession } from "@/lib/session";
import { deleteSource, listSources } from "@/lib/sources";
import { requestSyncFor } from "@/lib/sync/server";

// Removes the tokens. Records already imported stay until the person deletes them.
export async function disconnectAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const userId = session.user.id;
  await asUser(db, userId, (tx) => deleteConnection(tx, userId, String(formData.get("connectionId") ?? "")));
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

// Checks every connected organization for new records.
export async function refreshAllAction(): Promise<void> {
  const session = await requireSession();
  const sources = (await asUser(db, session.user.id, (tx) => listSources(tx, session.user.id))).filter((s) => s.status === "connected");
  const outcomes = await Promise.all(
    sources.map((s) =>
      requestSyncFor(session.user.id, s.id, "manual").catch((error: unknown) => {
        console.error("[sync] queueing failed", error instanceof Error ? error.name : "unknown");
        return "failed" as const;
      }),
    ),
  );
  // One message for the lot: queued if any started, otherwise the most telling reason.
  const outcome = (["queued", "already_running", "cooldown", "failed"] as const).find((o) => outcomes.includes(o)) ?? "not_connected";
  revalidatePath("/app");
  redirect(`/app/connections?refresh=${outcome}`);
}

// Deletes the organization and everything stored from it: records, sync history and tokens.
export async function deleteSourceAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const userId = session.user.id;
  await asUser(db, userId, (tx) => deleteSource(tx, userId, String(formData.get("sourceId") ?? "")));
  revalidatePath("/app");
  redirect("/app/connections?deleted=1");
}
