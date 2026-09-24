import { describe, expect, it } from "vitest";
import { passwordResetEmail, verificationEmail } from "./email-templates";

describe("email templates", () => {
  it("builds the verification email around the link", () => {
    const email = verificationEmail({ to: "a@example.com", url: "https://app.test/verify?token=t" });
    expect(email.to).toBe("a@example.com");
    expect(email.subject).toBe("Confirm your email for Wild Hearts Health");
    expect(email.text).toContain("https://app.test/verify?token=t");
    expect(email.text).not.toMatch(/!/);
  });

  it("builds the password reset email around the link", () => {
    const email = passwordResetEmail({ to: "a@example.com", url: "https://app.test/reset?token=t" });
    expect(email.subject).toBe("Reset your Wild Hearts Health password");
    expect(email.text).toContain("https://app.test/reset?token=t");
    expect(email.text).toContain("you can ignore this email");
  });
});
