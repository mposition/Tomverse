import "server-only";

/**
 * Public Guest Chat entry is available in the static marketing document.
 * It grants no account, Auto or Refiner capability and requires no session,
 * database or auth secret at build time. After the session resolves, a signed-in
 * visitor's link is decided by the existing private Chat capability API.
 */
export const PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE = true;
