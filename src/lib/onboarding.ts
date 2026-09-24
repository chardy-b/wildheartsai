import { z } from "zod";
import type { Profile } from "./profile";

// Bump this whenever ACKNOWLEDGEMENTS change; everyone re-acknowledges on their next visit.
export const CONSENT_VERSION = "2026-09-launch-1";

type Acknowledgement = { id: string; text: string; link?: { href: string; label: string } };

export const ACKNOWLEDGEMENTS: readonly Acknowledgement[] = [
  {
    id: "not-medical-advice",
    text: "Wild Hearts Health is not a medical provider and does not give medical advice. I'll bring questions about my health to my care team.",
  },
  {
    id: "privacy-notice",
    text: "Wild Hearts keeps the access my health systems grant, encrypted, and uses it only to show my records to me. I've read the privacy notice.",
    link: { href: "/privacy", label: "Read the privacy notice" },
  },
];

export const nameSchema = z.object({
  preferredName: z
    .string()
    .trim()
    .min(1, "Tell us what to call you.")
    .max(60, "Keep it under 60 characters."),
});

const confirmed = z.literal("on", { error: "Please confirm both statements to continue." });

export const acknowledgeSchema = z.object({
  "not-medical-advice": confirmed,
  "privacy-notice": confirmed,
});

export type OnboardingStep = "name" | "acknowledge" | "connect" | "done";

export function onboardingStep(profile: Profile | undefined): OnboardingStep {
  if (!profile?.preferredName) return "name";
  if (profile.consentVersion !== CONSENT_VERSION) return "acknowledge";
  if (!profile.onboardedAt) return "connect";
  return "done";
}
