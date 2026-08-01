/**
 * The vocabulary every guest-verification surface shares.
 *
 * It lives in its own module -- rather than inside GuestVerificationProvider --
 * so the standalone-form hook (`useTurnstile`) can describe an outcome with
 * exactly the same words the chat coordinator uses, without importing a React
 * provider to do it.
 */

export type GuestVerificationFailure =
  | "failed"
  | "unavailable"
  | "cancelled"
  | "timeout"
  | "expired";

export type GuestVerificationOutcome = "succeeded" | GuestVerificationFailure;

export class GuestVerificationError extends Error {
  readonly kind: GuestVerificationFailure;

  constructor(kind: GuestVerificationFailure) {
    // Deliberately generic: never carries a token, a site key or a Cloudflare
    // payload, because this message reaches logs and error surfaces.
    super(`Guest verification ${kind}.`);
    this.name = "GuestVerificationError";
    this.kind = kind;
  }
}

export const isGuestVerificationError = (
  error: unknown
): error is GuestVerificationError =>
  error instanceof GuestVerificationError ||
  (typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "GuestVerificationError");
