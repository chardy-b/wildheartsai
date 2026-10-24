"use server";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getRealSession } from "@/lib/session";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { ensureDemoWorkspace } from "@/lib/demo/workspace";
import { DEMO_MODE_COOKIE, demoModeValue } from "@/lib/demo/identity";
import { isDemoUser } from "@/lib/demo/access";

export async function enterDemo() {
  if (process.env.DEMO_ENABLED !== "1") notFound();
  const identity = await getRealSession();
  if (!identity?.user.emailVerified) redirect("/demo");
  if (!isDemoUser(identity.user.id)) {
    try { await ensureDemoWorkspace(db, recordsKey(), identity); }
    catch { throw new Error("The demo could not open. Please try again."); }
    (await cookies()).set(DEMO_MODE_COOKIE, demoModeValue(identity.session.id), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" });
  }
  redirect("/app/demo");
}

export async function leaveDemo() {
  (await cookies()).delete(DEMO_MODE_COOKIE);
  redirect("/app");
}
