// Verification and reset emails: links only, never health information. Templates ported from
// src/lib/email-templates.ts unchanged.
//
// Sent with Cloudflare Email Sending (owner decision, 2026-11-20; Google Workspace keeps the
// inboxes): the `EMAIL` send_email binding, production only. Without it:
// - development prints the message, so the link can be opened locally (as in the Next app);
// - preview prints it only when EMAIL_LOG_LINKS is true (preview data is made up);
// - otherwise it refuses: no link is sent or printed. Better Auth logs the failure but still
//   answers 200, as it does on Vercel today.

export type Email = { to: string; subject: string; text: string };
export type SendEmail = (email: Email) => Promise<void>;

type LinkEmail = { to: string; url: string };

export function verificationEmail({ to, url }: LinkEmail): Email {
  return {
    to,
    subject: "Confirm your email for Wild Hearts Health",
    text: [
      "Hello,",
      "",
      "Confirm your email to finish creating your Wild Hearts Health account:",
      url,
      "",
      "If you didn't create an account, you can ignore this email.",
      "",
      "Wild Hearts Health",
    ].join("\n"),
  };
}

export function passwordResetEmail({ to, url }: LinkEmail): Email {
  return {
    to,
    subject: "Reset your Wild Hearts Health password",
    text: [
      "Hello,",
      "",
      "Use this link to choose a new password. It expires in one hour:",
      url,
      "",
      "If you didn't ask to reset your password, you can ignore this email.",
      "",
      "Wild Hearts Health",
    ].join("\n"),
  };
}

export class EmailUnavailableError extends Error {}

type Options = {
  appEnv: "development" | "preview" | "production";
  logLinks: boolean;
  // Cloudflare Email Sending, and the sender as EMAIL_FROM gives it ("Name <address>").
  binding?: Pick<SendEmailBinding, "send">;
  from?: string;
  log?: (line: string) => void;
};

type SendEmailBinding = { send(message: { from: string | { name: string; email: string }; to: string; subject: string; text: string }): Promise<unknown> };

// "Wild Hearts Health <no-reply@example.test>" → { name, email }; a bare address stays a string.
export function sender(from: string): string | { name: string; email: string } {
  const match = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from);
  return match ? { name: match[1].replace(/^"|"$/g, ""), email: match[2] } : from.trim();
}

export function createEmailSender({ appEnv, logLinks, binding, from, log = console.info }: Options): SendEmail {
  if (appEnv === "development" || (appEnv === "preview" && logLinks)) {
    // The recipient is left out on purpose.
    return async (email) => log(`[email] ${email.subject}\n${email.text}`);
  }
  if (binding && from) {
    // Errors carry no address or link; Better Auth logs that sending failed.
    return async (email) => {
      try {
        await binding.send({ from: sender(from), to: email.to, subject: email.subject, text: email.text });
      } catch (error) {
        throw new EmailUnavailableError(`Email Sending refused the message${error instanceof Error && "code" in error ? ` (${String((error as { code: unknown }).code)})` : ""}`);
      }
    };
  }
  return async () => {
    throw new EmailUnavailableError("No email provider is configured");
  };
}
