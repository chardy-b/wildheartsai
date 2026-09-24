import nodemailer from "nodemailer";
import { env } from "@/lib/env";

export type Email = { to: string; subject: string; text: string };
export type SendEmail = (email: Email) => Promise<void>;
export type Mailer = (message: Email & { from: string }) => Promise<unknown>;

type Options = {
  from: string;
  production: boolean;
  mailer?: Mailer;
  log?: (line: string) => void;
};

export function createEmailSender({ from, production, mailer, log = console.info }: Options): SendEmail {
  if (!mailer) {
    if (production) throw new Error("SMTP_USER and SMTP_PASS are required in production");
    // Development only: print the message so the link can be opened locally.
    // The recipient is left out on purpose.
    return async (email) => log(`[email] ${email.subject}\n${email.text}`);
  }

  return async (email) => {
    try {
      await mailer({ from, to: email.to, subject: email.subject, text: email.text });
    } catch (error) {
      // SMTP errors can echo addresses; report only the error code.
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      throw new Error(`Email delivery failed (${code})`);
    }
  };
}

// Google Workspace: the no-reply mailbox signs in to Gmail's SMTP server with an app password.
export function gmailTransportOptions(user: string, pass: string) {
  return { host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } };
}

let transport: ReturnType<typeof nodemailer.createTransport> | undefined;

export function sendEmail(email: Email): Promise<void> {
  const { SMTP_USER, SMTP_PASS, EMAIL_FROM } = env();
  const mailer: Mailer | undefined =
    SMTP_USER && SMTP_PASS
      ? (message) => (transport ??= nodemailer.createTransport(gmailTransportOptions(SMTP_USER, SMTP_PASS))).sendMail(message)
      : undefined;
  return createEmailSender({ from: EMAIL_FROM, production: process.env.NODE_ENV === "production", mailer })(email);
}
