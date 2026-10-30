import { describe, expect, it } from "vitest";
import { createEmailSender, EmailUnavailableError, passwordResetEmail, verificationEmail } from "../src/auth/email";

const email = verificationEmail({ to: "person@example.test", url: "https://wildheartsai.test/verify?token=made-up" });

describe("email", () => {
  it("prints links in development, without the recipient", async () => {
    const lines: string[] = [];
    await createEmailSender({ appEnv: "development", logLinks: false, log: (line) => lines.push(line) })(email);
    expect(lines.join("\n")).toContain("https://wildheartsai.test/verify?token=made-up");
    expect(lines.join("\n")).not.toContain("person@example.test");
  });

  it("prints links on preview only when allowed", async () => {
    const lines: string[] = [];
    await createEmailSender({ appEnv: "preview", logLinks: true, log: (line) => lines.push(line) })(email);
    expect(lines).toHaveLength(1);
    await expect(createEmailSender({ appEnv: "preview", logLinks: false, log: (line) => lines.push(line) })(email)).rejects.toThrow(EmailUnavailableError);
  });

  it("never prints links in production", async () => {
    const lines: string[] = [];
    await expect(createEmailSender({ appEnv: "production", logLinks: true, log: (line) => lines.push(line) })(email)).rejects.toThrow(EmailUnavailableError);
    expect(lines).toEqual([]);
  });

  it("keeps the Next app's wording", () => {
    expect(passwordResetEmail({ to: "p@example.test", url: "u" }).subject).toBe("Reset your Wild Hearts Health password");
    expect(email.text).toContain("If you didn't create an account, you can ignore this email.");
  });
});
