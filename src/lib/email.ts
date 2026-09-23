import { env } from "@/lib/env";

export type Email = { to: string; subject: string; text: string };
export type SendEmail = (email: Email) => Promise<void>;

type Options = {
  apiKey?: string;
  from: string;
  production: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

export function createEmailSender({
  apiKey,
  from,
  production,
  fetchImpl = fetch,
  log = console.info,
}: Options): SendEmail {
  if (!apiKey) {
    if (production) throw new Error("RESEND_API_KEY is required in production");
    // Development only: print the message so the link can be opened locally.
    // The recipient is left out on purpose.
    return async (email) => log(`[email] ${email.subject}\n${email.text}`);
  }

  return async (email) => {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text }),
    });
    if (!response.ok) throw new Error(`Email provider responded ${response.status}`);
  };
}

export function sendEmail(email: Email): Promise<void> {
  const { RESEND_API_KEY, EMAIL_FROM } = env();
  return createEmailSender({
    apiKey: RESEND_API_KEY,
    from: EMAIL_FROM,
    production: process.env.NODE_ENV === "production",
  })(email);
}
