import { describe, expect, it } from "vitest";
import { acknowledgeSchema, CONSENT_VERSION, nameSchema, onboardingStep } from "./onboarding";
import type { Profile } from "./profile";

const base: Profile = {
  userId: "u1",
  preferredName: null,
  consentVersion: null,
  consentedAt: null,
  onboardedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("onboardingStep", () => {
  it("starts at the name step with no profile", () => {
    expect(onboardingStep(undefined)).toBe("name");
  });

  it("moves through name, acknowledge, connect, done", () => {
    expect(onboardingStep(base)).toBe("name");
    const named = { ...base, preferredName: "Sam" };
    expect(onboardingStep(named)).toBe("acknowledge");
    const acknowledged = { ...named, consentVersion: CONSENT_VERSION, consentedAt: new Date() };
    expect(onboardingStep(acknowledged)).toBe("connect");
    expect(onboardingStep({ ...acknowledged, onboardedAt: new Date() })).toBe("done");
  });

  it("asks again when the acknowledgement version changes", () => {
    const outdated = { ...base, preferredName: "Sam", consentVersion: "older", onboardedAt: new Date() };
    expect(onboardingStep(outdated)).toBe("acknowledge");
  });
});

describe("nameSchema", () => {
  it("trims and accepts a name", () => {
    expect(nameSchema.parse({ preferredName: "  Sam  " })).toEqual({ preferredName: "Sam" });
  });

  it("rejects an empty or very long name", () => {
    expect(nameSchema.safeParse({ preferredName: "   " }).success).toBe(false);
    expect(nameSchema.safeParse({ preferredName: "x".repeat(61) }).success).toBe(false);
  });
});

describe("acknowledgeSchema", () => {
  it("requires both statements to be checked", () => {
    expect(acknowledgeSchema.safeParse({ "not-medical-advice": "on", "test-environment": "on" }).success).toBe(true);
    const missing = acknowledgeSchema.safeParse({ "not-medical-advice": "on" });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.message).toBe("Please confirm both statements to continue.");
  });
});
