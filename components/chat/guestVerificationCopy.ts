import type { GuestVerificationFailure } from "@/components/chat/guestVerificationFailure";

/**
 * The surface a failure is being described on. Both dictionaries say the same
 * thing about the same outcome; they differ only in what the user is told is
 * still safe -- a chat send keeps a draft and its attachments, a feedback form
 * keeps what was typed into it.
 */
export type GuestVerificationSurface = "chat" | "feedback";

/**
 * One mapping from a verification outcome to the sentence the user reads, so
 * the desktop slot, the mobile sheet, the chat feedback modal and the support
 * form can never describe the same failure differently. Every string goes
 * through the locale dictionaries; none of them ever includes a token, a site
 * key or a Cloudflare payload.
 */
export const guestVerificationFailureKey = (
  failure: GuestVerificationFailure,
  surface: GuestVerificationSurface = "chat"
) => {
  const namespace =
    surface === "feedback" ? "feedback.verification" : "chat.guestVerification";
  switch (failure) {
    case "unavailable":
      return `${namespace}Unavailable`;
    case "cancelled":
      return `${namespace}Cancelled`;
    case "timeout":
      return `${namespace}Timeout`;
    case "expired":
      return `${namespace}Expired`;
    default:
      return `${namespace}Failed`;
  }
};
