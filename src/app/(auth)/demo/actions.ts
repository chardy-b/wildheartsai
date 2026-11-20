"use server";

import { assertWritable } from "@/lib/read-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getRealSession } from "@/lib/session";
import { backend } from "@/lib/backend";
import { DEMO_GUEST_COOKIE, DEMO_MODE_COOKIE, demoModeValue } from "@/lib/demo/identity";
import { isDemoUser } from "@/lib/demo/access";

export async function enterDemo() {
  assertWritable();
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

// Anyone, without an account (where the backend offers it): a day's view of the central demo chart.
export async function enterGuestDemo() {
  assertWritable();
  const api = await backend();
  if (process.env.DEMO_ENABLED !== "1" || !api.guestDemoAvailable()) notFound();
  if (await getRealSession()) return enterDemo();
  const opened = await api.openGuestDemo();
  (await cookies()).set(DEMO_GUEST_COOKIE, opened.cookie, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: opened.expiresAt });
  redirect("/app/demo");
}

// Nothing was stored for the guest, so leaving only forgets the cookie.
export async function leaveGuestDemo() {
  (await cookies()).delete(DEMO_GUEST_COOKIE);
  redirect("/demo");
}
