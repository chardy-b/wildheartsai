import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/AuthCard";
import { db } from "@/lib/db";
import { onboardingStep, type OnboardingStep } from "@/lib/onboarding";
import { getProfile } from "@/lib/profile";
import { requireSession } from "@/lib/session";
import { AcknowledgeStep } from "./AcknowledgeStep";
import { ConnectStep } from "./ConnectStep";
import { NameStep } from "./NameStep";
import "@/components/auth/auth.css";
import "./onboarding.css";

export const metadata: Metadata = { title: "Getting started | Wild Hearts Health" };

const ORDER: OnboardingStep[] = ["name", "acknowledge", "connect"];

export default async function OnboardingPage() {
  const session = await requireSession();
  const step = onboardingStep(await getProfile(db, session.user.id));
  if (step === "done") redirect("/app");
  const current = ORDER.indexOf(step);

  return (
    <div className="onboarding">
      <ol className="ob-steps" aria-label="Getting started progress">
        {ORDER.map((name, i) => (
          <li
            key={name}
            className={i < current ? "ob-done" : undefined}
            aria-current={i === current ? "step" : undefined}
          >
            {i + 1}
          </li>
        ))}
      </ol>
      {step === "name" ? (
        <AuthCard title="What should we call you?" lede="We'll use this name around the app.">
          <NameStep defaultName={session.user.name} />
        </AuthCard>
      ) : null}
      {step === "acknowledge" ? (
        <AuthCard title="Before we start." lede="Two things to know about early access.">
          <AcknowledgeStep />
        </AuthCard>
      ) : null}
      {step === "connect" ? (
        <AuthCard
          title="Connect your first health system."
          lede="You'll sign in on your health system's own MyChart page. We never see your MyChart password."
        >
          <ConnectStep />
        </AuthCard>
      ) : null}
    </div>
  );
}
