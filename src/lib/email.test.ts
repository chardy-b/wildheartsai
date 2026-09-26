import { describe, expect, it, vi } from "vitest";
import { createEmailSender } from "./email";

const email = { to: "person@example.com", subject: "Confirm your email", text: "Open https://x.test/verify" };
const from = "Wild Hearts Health <no-reply@wildheartsai.com>";

describe("createEmailSender", () => {
  it("logs subject and body without the recipient when no mailbox is configured in development", async () => {
    const log = vi.fn();
    await createEmailSender({ from, production: false, log })(email);
    expect(log).toHaveBeenCalledOnce();
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("Confirm your email");
    expect(line).toContain("https://x.test/verify");
    expect(line).not.toContain("person@example.com");
  });

  it("refuses to run without a mailbox in production", () => {
    expect(() => createEmailSender({ from, production: true })).toThrow(/EMAIL binding/);
  });

  it("sends through the mailer with the configured From address", async () => {
    const mailer = vi.fn().mockResolvedValue({ messageId: "m1" });
    await createEmailSender({ from, production: true, mailer })(email);
    expect(mailer).toHaveBeenCalledWith({
      from,
      to: "person@example.com",
      subject: "Confirm your email",
      text: "Open https://x.test/verify",
    });
  });

  it("reports delivery failures by error code only", async () => {
    const failure = Object.assign(new Error("Sender not verified for person@example.com"), { code: "E_SENDER_NOT_VERIFIED" });
    const mailer = vi.fn().mockRejectedValue(failure);
    const send = createEmailSender({ from, production: true, mailer });
    await expect(send(email)).rejects.toThrow("Email delivery failed (E_SENDER_NOT_VERIFIED)");
    await expect(send(email)).rejects.not.toThrow(/person@example.com/);
  });
});
