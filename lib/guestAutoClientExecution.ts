export type GuestAutoClientExecutionState =
  | "manual"
  | "awaiting_capability"
  | "auto_ready";

/**
 * Resolves the execution mode the Guest Chat client may honestly act on.
 *
 * A locally restored `auto` value is only intent. It cannot authorize a paid
 * turn until the current Chat surface has both the server-owned `offered`
 * decision and its request-memory authority. Treating that gap as manual
 * would make the UI promise Smart Adaptive while dispatching the fallback
 * model, so it is a closed preparation state instead.
 */
export const guestAutoClientExecutionState = (input: {
  isGuestMode: boolean;
  surface: "chat" | "review";
  selectionMode: "manual" | "auto";
  offered: boolean;
  hasCapability: boolean;
}): GuestAutoClientExecutionState => {
  if (!input.isGuestMode || input.surface !== "chat" || input.selectionMode === "manual") {
    return "manual";
  }
  return input.offered && input.hasCapability
    ? "auto_ready"
    : "awaiting_capability";
};
