/** Content-free metadata kept with one panel's in-memory retry source. */
export type GuestAutoRetryMetadata = {
  /** A Guest Auto authority is single-turn and may never become a manual retry. */
  guestAutoRetryBlocked?: true;
};

export const guestAutoRetryMetadata = (
  isGuestMode: boolean,
  guestAutoCapability?: string
): GuestAutoRetryMetadata =>
  isGuestMode && Boolean(guestAutoCapability)
    ? { guestAutoRetryBlocked: true }
    : {};

export const isGuestAutoRetryBlocked = (
  isGuestMode: boolean,
  prompt: GuestAutoRetryMetadata | null
) => isGuestMode && prompt?.guestAutoRetryBlocked === true;
