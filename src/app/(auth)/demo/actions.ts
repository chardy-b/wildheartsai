"use server";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getRealSession } from "@/lib/session";
import { backend } from "@/lib/backend";
import { DEMO_MODE_COOKIE, demoModeValue } from "@/lib/demo/identity";
import { isDemoUser } from "@/lib/demo/access";

export async function enterDemo() {
  if (process.env.DEMO_ENABLED !== "1") notFound();
  const identity = await getRealSession();
  if (!identity?.user.emailVerified) redirect("/demo");
  if (!isDemoUser(identity.user.id)) {
    try { await (await backend()).openDemoWorkspace(identity); }
    catch { throw new Error("The demo could not open. Please try again."); }
    (await cookies()).set(DEMO_MODE_COOKIE, demoModeValue(identity.session.id), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" });
  }
  redirect("/app/demo");
}

export async function leaveDemo() {
  (await cookies()).delete(DEMO_MODE_COOKIE);
  redirect("/app");
}
