import { describe, expect, it, vi } from "vitest";
import { createEmailSender } from "./email";

const email = { to: "person@example.com", subject: "Confirm your email", text: "Open https://x.test/verify" };

describe("createEmailSender", () => {
  it("logs subject and body without the recipient when there is no API key in development", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn();
    await createEmailSender({ from: "WH <hi@example.com>", production: false, log, fetchImpl })(email);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("Confirm your email");
    expect(line).toContain("https://x.test/verify");
    expect(line).not.toContain("person@example.com");
  });

  it("refuses to run without an API key in production", () => {
    expect(() => createEmailSender({ from: "WH <hi@example.com>", production: true })).toThrow(/RESEND_API_KEY/);
  });

  it("posts to Resend when an API key is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await createEmailSender({ apiKey: "re_test", from: "WH <hi@example.com>", production: true, fetchImpl })(email);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    expect(JSON.parse(init.body)).toEqual({
      from: "WH <hi@example.com>",
      to: ["person@example.com"],
      subject: "Confirm your email",
      text: "Open https://x.test/verify",
    });
  });

  it("throws when Resend rejects the message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 422 }));
    const send = createEmailSender({ apiKey: "re_test", from: "WH <hi@example.com>", production: true, fetchImpl });
    await expect(send(email)).rejects.toThrow("Email provider responded 422");
  });
});
