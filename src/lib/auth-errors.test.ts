import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./auth-errors";

describe("authErrorMessage", () => {
  it.each([
    [{ code: "EMAIL_NOT_VERIFIED", status: 403 }, "Please confirm your email first. We sent you a link when you signed up."],
    [{ code: "USER_ALREADY_EXISTS", status: 422 }, "An account with this email already exists. Try signing in instead."],
    [{ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 }, "That email and password don't match. Try again or reset your password."],
    [{ code: "PASSWORD_TOO_SHORT", status: 400 }, "Use at least 12 characters for your password."],
    [{ status: 429 }, "Too many attempts. Wait a minute, then try again."],
    [{ status: 500 }, "Something went wrong on our side. Please try again."],
  ])("maps %o to calm copy", (error, message) => {
    expect(authErrorMessage(error)).toBe(message);
  });

  it("falls back to status codes when the code is missing", () => {
    expect(authErrorMessage({ status: 403 })).toMatch(/confirm your email/);
    expect(authErrorMessage({ status: 401 })).toMatch(/don't match/);
  });
});
