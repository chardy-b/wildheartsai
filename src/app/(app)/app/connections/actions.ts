"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { deleteConnection } from "@/lib/epic/connections";
import { requireSession } from "@/lib/session";

export async function disconnectAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await deleteConnection(db, session.user.id, String(formData.get("connectionId") ?? ""));
  revalidatePath("/app/connections");
  revalidatePath("/app");
}
