import { GuestVerificationError } from "@/components/chat/guestVerificationFailure";

/**
 * The "one challenge, one token, everyone else waits" rule for guest chat,
 * as a pure function so its failure semantics are unit-testable without React.
 *
 * Contract (see GuestVerificationProvider, which owns the widget itself):
 *
 *  - The first panel to arrive becomes the verifier: it runs the challenge and
 *    retries its own request with the token.
 *  - Panels that arrive while that is in flight wait for the verifier's FULL
 *    verified retry -- not just for the token -- because only a completed,
 *    successful retry proves the server issued the grant cookie their own
 *    tokenless retry relies on.
 *  - If the verifier fails -- the challenge itself (failed / cancelled /
 *    timeout / expired / unavailable), a network error, or the server
 *    rejecting the verified retry -- that failure propagates to every waiting
 *    panel and NONE of them sends another request. A tokenless retry without a
 *    grant can only harvest another TURNSTILE_REQUIRED, so the alternative is
 *    a retry storm that ends in the very error the wait was meant to avoid.
 *  - When verification cannot run at all (no site key, no provider), the
 *    request fails as a typed GuestVerificationError("unavailable") instead of
 *    repeating the tokenless request the server has already refused.
 */
export type GuestChatCoordinatorState = {
  /**
   * Settles when the verifier's verified retry settles, with the SAME outcome:
   * it must reject when the verifier failed. (The value is erased so a waiting
   * panel can never read the verifier's response.)
   */
  inFlight: Promise<void> | null;
};

export const createGuestChatCoordinatorState = (): GuestChatCoordinatorState => ({
  inFlight: null,
});

export type GuestChatRequestRun<T> = {
  /** True only when this page can actually run a challenge. */
  isEnabled: boolean;
  /** Resolves with a token once the (single) challenge succeeds. */
  requestToken: () => Promise<string | undefined>;
  /** Runs once real verification produced a token (or is not configured). */
  sendWithToken: (token: string | undefined) => Promise<T>;
  /**
   * Runs for the panels that waited: by then the verifier's successful retry
   * has already set the server's grant cookie, so these must NOT spend a token.
   */
  sendAfterGrant: () => Promise<T>;
};

export const runCoordinatedGuestChatRequest = async <T>(
  state: GuestChatCoordinatorState,
  { isEnabled, requestToken, sendWithToken, sendAfterGrant }: GuestChatRequestRun<T>
): Promise<T> => {
  const inFlight = state.inFlight;
  if (inFlight) {
    // Not caught here on purpose: the verifier's failure is this panel's
    // failure. Swallowing it and calling sendAfterGrant() anyway was the bug
    // that produced tokenless retries against a server that had issued no
    // grant, surfacing raw TURNSTILE_REQUIRED in every waiting panel.
    await inFlight;
    return sendAfterGrant();
  }

  if (!isEnabled) {
    // The server demanded verification but this page cannot host a challenge
    // (missing public site key, or no coordinator mounted). Repeating the
    // tokenless request cannot change the server's answer.
    throw new GuestVerificationError("unavailable");
  }

  const verifyAndRetry = (async () => {
    const token = await requestToken();
    return sendWithToken(token);
  })();
  const shared = verifyAndRetry.then(() => undefined);
  // The verifier itself awaits verifyAndRetry below, so its failure is always
  // handled; this handler only keeps the shared copy from being reported as an
  // unhandled rejection when no panel happens to be waiting on it.
  shared.catch(() => {});
  state.inFlight = shared;
  try {
    return await verifyAndRetry;
  } finally {
    state.inFlight = null;
  }
};
