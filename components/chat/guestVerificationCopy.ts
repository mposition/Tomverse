import type { GuestVerificationFailure } from "@/components/chat/GuestVerificationProvider";

/**
 * One mapping from a verification outcome to the sentence the user reads, so
 * the desktop slot and the mobile sheet can never describe the same failure
 * differently. Every string goes through the locale dictionaries; none of them
 * ever includes a token, a site key or a Cloudflare payload.
 */
export const guestVerificationFailureKey = (
  failure: GuestVerificationFailure
) => {
  switch (failure) {
    case "unavailable":
      return "chat.guestVerificationUnavailable";
    case "cancelled":
      return "chat.guestVerificationCancelled";
    case "timeout":
      return "chat.guestVerificationTimeout";
    case "expired":
      return "chat.guestVerificationExpired";
    default:
      return "chat.guestVerificationFailed";
  }
};
