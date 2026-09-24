import type { CallbackFailure } from "./callback";

export const CONNECT_ERRORS: Record<CallbackFailure | "unavailable", string> = {
  denied: "The connection was cancelled on the MyChart page. Nothing was shared.",
  expired: "That sign-in took too long. Please start again.",
  invalid_state: "That sign-in came from a different tab or an old link. Please start again.",
  token_failed: "The health system didn't finish the connection. Please try again in a few minutes.",
  unavailable: "We couldn't reach that health system just now. Please try again later.",
};

export function connectErrorMessage(value: unknown): string | undefined {
  return typeof value === "string" && value in CONNECT_ERRORS
    ? CONNECT_ERRORS[value as keyof typeof CONNECT_ERRORS]
    : undefined;
}
