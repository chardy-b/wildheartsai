import { getCloudflareContext } from "@opennextjs/cloudflare";
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
    if (production) throw new Error("The EMAIL binding (Cloudflare Email Service) is required in production");
    // Development only: print the message so the link can be opened locally.
    // The recipient is left out on purpose.
    return async (email) => log(`[email] ${email.subject}\n${email.text}`);
  }

  return async (email) => {
    try {
      await mailer({ from, to: email.to, subject: email.subject, text: email.text });
    } catch (error) {
      // Delivery errors can echo addresses; report only the error code.
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      throw new Error(`Email delivery failed (${code})`);
    }
  };
}

// Cloudflare Email Service, through the `EMAIL` send_email binding (wrangler.jsonc). EMAIL_FROM
// must be an address on a domain onboarded to Email Service. `next dev` prints emails instead.
export function sendEmail(email: Email): Promise<void> {
  const production = process.env.NODE_ENV === "production";
  const binding = production ? getCloudflareContext().env.EMAIL : undefined;
  const mailer: Mailer | undefined = binding ? (message) => binding.send(message) : undefined;
  return createEmailSender({ from: env().EMAIL_FROM, production, mailer })(email);
}
