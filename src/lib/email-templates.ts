import type { Email } from "./email";

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
