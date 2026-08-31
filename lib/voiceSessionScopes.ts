/**
 * Which conversation, and whose account, each voice session belongs to.
 *
 * Contract: docs/policy/voice-input.md §8.4.
 *
 * Pure and framework-free so both rules here are assertable. Neither can be
 * reached from a test through the hook that uses them — that needs a React
 * renderer — and both are the kind of rule that is wrong in a way nothing
 * notices until a transcript lands somewhere it should not.
 */

/** Sessions retained beyond the current one. See `createVoiceSessionScopes`. */
const RETAINED_SESSIONS = 2;

/**
 * The answer to "where did this session start?".
 *
 * A discriminated result rather than `string | null`, because `null` is a
 * *real* scope — the new-conversation draft — and "I no longer know" must not
 * collapse into it. It did: `scopeFor` returned `null` for a pruned session,
 * so a late callback for a forgotten session would have written its transcript
 * into the new-conversation draft. The lookup is fail-closed instead, and the
 * caller drops the transcript.
 */
export type VoiceScopeLookup =
  | { known: true; scopeId: string | null }
  | { known: false };

export type VoiceSessionScopes = {
  /** Records the scope a session started in. */
  remember: (sessionId: number, scopeId: string | null) => void;
  /** Where a session started, or `{ known: false }` if it is no longer held. */
  scopeFor: (sessionId: number) => VoiceScopeLookup;
  /** How many entries are held. For tests and for nothing else. */
  size: () => number;
};

/**
 * A bounded record of where each session started.
 *
 * This was a bare `Map` inside the hook: every session added an entry and
 * nothing removed one, so a tab left open all day accumulated one per
 * recording.
 *
 * ## Why anything is kept at all
 *
 * The scope is read when a transcript comes back, which is after the session
 * has usually already left the state machine's live states. "Delete it when
 * the session ends" would delete it moments before it is needed.
 *
 * ## Why so few are kept, and why a miss is not `null`
 *
 * A transcript for an abandoned session is dropped by the adapter before it
 * ever asks for a scope, so in practice only the newest session's entry is
 * read. Two are retained so a callback racing a freshly started session still
 * finds its own answer, and the cap is the backstop for any path neither
 * argument covers. That backstop is only safe because a miss is reported as a
 * miss — see `VoiceScopeLookup`.
 */
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
    scopeFor: (sessionId) =>
      scopes.has(sessionId)
        ? { known: true, scopeId: scopes.get(sessionId) ?? null }
        : { known: false },
    size: () => scopes.size,
  };
};

// ---------------------------------------------------------------------------
// The identity and scope boundary
// ---------------------------------------------------------------------------

export type VoiceSessionBoundary = {
  /** Whether a running session must end. */
  changed: boolean;
  /**
   * The identity to compare against next time.
   *
   * Returned rather than assumed to be `nextIdentity`, and that is the whole
   * point of this function's shape — see below.
   */
  identity: string | null;
};

/**
 * Whether a running session must end because it no longer belongs where it
 * started, and what to compare against next time.
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
 * signing in and misses account A being replaced by account B in the same tab
 * — the transition that matters most, because it is a privacy boundary rather
 * than a tidiness one. The key passed in is `identityNamespaceKey`
 * (`account:<userId>`), so accounts are distinct.
 *
 * ## Why an unknown identity does not *overwrite* the last known one
 *
 * `null` means the session provider has not settled. Treating `null` as a
 * change would cancel a recording started during hydration, so it is not one.
 * But the second version of this rule also *stored* the `null`, and that
 * reopened the exact hole it was written to close:
 *
 *     A -> null   no change, and the comparison basis became null
 *     null -> B   no change, because one side was null
 *
 * — so `A -> null -> B` passed through unnoticed, which is an account switch
 * with a session still running. The basis therefore keeps the last identity
 * that was actually known, and `null` is a gap in the record rather than a
 * value in it. `A -> null -> B` then compares A against B and ends the
 * session; `A -> null -> A` compares A against A and does not.
 */
export const resolveVoiceSessionBoundary = (input: {
  previousScope: string | null;
  nextScope: string | null;
  /** The last identity that was actually known, not merely the last seen. */
  lastKnownIdentity: string | null;
  nextIdentity: string | null;
}): VoiceSessionBoundary => {
  // An unknown identity never displaces a known one.
  const identity = input.nextIdentity ?? input.lastKnownIdentity;

  if (input.previousScope !== input.nextScope) return { changed: true, identity };
  if (input.nextIdentity === null || input.lastKnownIdentity === null) {
    return { changed: false, identity };
  }
  return {
    changed: input.lastKnownIdentity !== input.nextIdentity,
    identity,
  };
};
