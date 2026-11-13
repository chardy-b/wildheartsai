import { Hono } from "hono";
import { acknowledgeSchema, CONSENT_VERSION, nameSchema, onboardingStep } from "@/lib/onboarding";
import { completeOnboarding, getProfile, recordAcknowledgement, savePreferredName } from "../data/profile";
import { requireUser, type AppEnv } from "../session";

// Onboarding (src/app/(app)/app/onboarding in the Next app): what to call the person, their
// acknowledgements, and finishing. The web Worker turns errors into form messages.
export const profileRoutes = new Hono<AppEnv>();
profileRoutes.use("/profile", requireUser("json"));
profileRoutes.use("/profile/*", requireUser("json"));

profileRoutes.get("/profile", async (c) => {
  const profile = await getProfile(c.get("scope"));
  return c.json({ profile: profile ?? null, step: onboardingStep(profile) }, 200, { "Cache-Control": "no-store" });
});

profileRoutes.post("/profile/name", async (c) => {
  const parsed = nameSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
  await savePreferredName(c.get("scope"), parsed.data.preferredName, new Date());
  return c.json({ ok: true });
});

profileRoutes.post("/profile/acknowledge", async (c) => {
  const parsed = acknowledgeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
  await recordAcknowledgement(c.get("scope"), CONSENT_VERSION, new Date());
  return c.json({ ok: true });
});

profileRoutes.post("/profile/complete", async (c) => {
  await completeOnboarding(c.get("scope"), new Date());
  return c.json({ ok: true });
});
