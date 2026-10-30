// Verification and reset emails: links only, never health information. Templates ported from
// src/lib/email-templates.ts unchanged.
//
// No email provider is chosen yet (open question 1 in the migration plan; Gmail SMTP can't be
// used from a Worker). Until one is wired in:
// - development prints the message, so the link can be opened locally (as in the Next app);
// - preview prints it only when EMAIL_LOG_LINKS is true (preview data is made up);
// - production refuses: no link is sent or printed, so new accounts can't be verified and resets
//   can't complete. Better Auth logs the failure but still answers 200, as it does on Vercel today.

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
  log?: (line: string) => void;
};

export function createEmailSender({ appEnv, logLinks, log = console.info }: Options): SendEmail {
  if (appEnv === "development" || (appEnv === "preview" && logLinks)) {
    // The recipient is left out on purpose.
    return async (email) => log(`[email] ${email.subject}\n${email.text}`);
  }
  return async () => {
    throw new EmailUnavailableError("No email provider is configured");
  };
}
