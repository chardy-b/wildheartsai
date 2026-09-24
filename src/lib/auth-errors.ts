export type AuthError = { status?: number; code?: string; message?: string };

export function authErrorMessage(error: AuthError): string {
  switch (error.code) {
    case "INVITE_CODE_INVALID":
      return "That invite code isn't right. Check it and try again.";
    case "PASSWORD_TOO_SHORT":
      return "Use at least 12 characters for your password.";
    case "EMAIL_NOT_VERIFIED":
      return "Please confirm your email first. We sent you a link when you signed up.";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "An account with this email already exists. Try signing in instead.";
    case "INVALID_EMAIL_OR_PASSWORD":
      return "That email and password don't match. Try again or reset your password.";
  }
  switch (error.status) {
    case 401:
      return "That email and password don't match. Try again or reset your password.";
    case 403:
      return "Please confirm your email first. We sent you a link when you signed up.";
    case 422:
      return "An account with this email already exists. Try signing in instead.";
    case 429:
      return "Too many attempts. Wait a minute, then try again.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}
