import { describe, expect, it } from "vitest";
import { acknowledgeSchema, ACKNOWLEDGEMENTS, CONSENT_VERSION, nameSchema, onboardingStep } from "./onboarding";
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

describe("ACKNOWLEDGEMENTS", () => {
  it("covers the privacy notice, re-asked now that records are stored", () => {
    expect(CONSENT_VERSION).toBe("2026-09-stored-records");
    expect(ACKNOWLEDGEMENTS.map((item) => item.id)).toEqual(["not-medical-advice", "privacy-notice"]);
    expect(ACKNOWLEDGEMENTS.find((item) => item.id === "privacy-notice")?.link).toEqual({ href: "/privacy", label: "I've read the privacy notice." });
  });
});

describe("acknowledgeSchema", () => {
  it("requires both statements to be checked", () => {
    expect(acknowledgeSchema.safeParse({ "not-medical-advice": "on", "privacy-notice": "on" }).success).toBe(true);
    expect(acknowledgeSchema.safeParse({ "not-medical-advice": "on", "test-environment": "on" }).success).toBe(false);
    const missing = acknowledgeSchema.safeParse({ "not-medical-advice": "on" });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.message).toBe("Please confirm both statements to continue.");
  });
});
