/**
 * Which conversation each voice session was started in.
 *
 * Contract: docs/policy/voice-input.md §8.4.
 *
 * Pure and framework-free so the retention rule is assertable. It was a bare
 * `Map` inside the hook that grew for as long as the composer stayed mounted:
 * every session added an entry and nothing ever removed one, so a tab left
 * open all day accumulated one per recording. Small, but unbounded, and the
 * fix is a rule rather than a cleanup call sprinkled at each exit — there are
 * four ways a session ends and the sprinkled version only has to miss one.
 *
 * ## Why anything is kept at all
 *
 * The scope is read when a transcript comes back, which is after the session
 * has usually already left the state machine's live states. So the entry has
 * to outlive the session it belongs to, and "delete it when the session ends"
 * would delete it moments before it is needed.
 *
 * ## Why so few are kept
 *
 * A transcript for an abandoned session is dropped by the adapter before it
 * ever asks for a scope, so in practice only the newest session's entry is
 * ever read. Two are retained rather than one purely so an in-flight callback
 * that races a freshly started session still finds its own answer, and the
 * cap is the backstop for any path neither of those arguments covers.
 */

/** Sessions retained beyond the current one. See the header. */
const RETAINED_SESSIONS = 2;

export type VoiceSessionScopes = {
  /** Records the scope a session started in. */
  remember: (sessionId: number, scopeId: string | null) => void;
  /** The scope a session started in, or `null` if it is no longer known. */
  scopeFor: (sessionId: number) => string | null;
  /** How many entries are held. For tests and for nothing else. */
  size: () => number;
};

export const createVoiceSessionScopes = (
  retained: number = RETAINED_SESSIONS
): VoiceSessionScopes => {
  const scopes = new Map<number, string | null>();

  const prune = () => {
    if (scopes.size <= retained) return;
    // Session ids only ever increase, so "oldest" is "smallest" and anything
    // far enough behind the newest can no longer be asked about.
    const ordered = [...scopes.keys()].sort((a, b) => a - b);
    for (const sessionId of ordered.slice(0, ordered.length - retained)) {
      scopes.delete(sessionId);
    }
  };

  return {
    remember: (sessionId, scopeId) => {
      scopes.set(sessionId, scopeId);
      prune();
    },
    // `??` rather than `||`: `null` is a real scope — the new-conversation
    // draft — and must not be confused with "no entry".
    scopeFor: (sessionId) => scopes.get(sessionId) ?? null,
    size: () => scopes.size,
  };
};

/**
 * Whether a running session must end because it no longer belongs where it
 * started.
 *
 * Contract: docs/policy/voice-input.md §8.4.
 *
 * Two boundaries, one rule, because they fail the same way: a transcript that
 * arrives after either has moved would be written into a draft that is not the
 * one the words were spoken into.
 *
 * ## Why identity is compared as a *person*
 *
 * The first version compared `"guest"` against `"account"`. That sees a guest
 * signing in, and misses account A being replaced by account B in the same
 * tab — which is the transition that matters most, because it is a privacy
 * boundary rather than a tidiness one. The key passed in is
 * `identityNamespaceKey` (`account:<userId>`), so the accounts are distinct.
 *
 * ## Why an unknown identity is never a change
 *
 * `null` means the session provider has not settled yet, on either side of the
 * comparison. Treating `null -> account:x` as a change would cancel a
 * recording started during hydration, and `account:x -> null` (a refetch)
 * would cancel one for no reason at all. Neither is the user going anywhere.
 */
export const voiceSessionBoundaryChanged = (input: {
  previousScope: string | null;
  nextScope: string | null;
  previousIdentity: string | null;
  nextIdentity: string | null;
}): boolean => {
  if (input.previousScope !== input.nextScope) return true;
  if (input.previousIdentity === null || input.nextIdentity === null) {
    return false;
  }
  return input.previousIdentity !== input.nextIdentity;
};
