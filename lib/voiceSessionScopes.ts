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
 * ## When the scope is actually read
 *
 * From `onTranscript`, which `lib/voiceCaptureAdapter.ts` invokes immediately
 * *before* it dispatches `transcription_succeeded` — so the session is still
 * live at read time, and the entry being read is the newest one. Nothing here
 * is read after a session has finished.
 *
 * ## One entry is enough today; the second is declared margin
 *
 * Two things together mean only the newest entry is ever read, and this is
 * worth saying plainly rather than inventing a race for the number to guard:
 *
 *   * the machine ignores `start_requested` while it is busy, and
 *     `isVoiceRecorderBusy` counts `transcribing` — so no new session can
 *     `remember` itself while a previous session's upload is outstanding;
 *   * a session that was abandoned is in the adapter's `discarded` set, which
 *     is checked *before* `onTranscript` — so its scope is never asked for.
 *
 * `RETAINED_SESSIONS = 1` would therefore be correct for the code as it
 * stands, and `tests/voiceSessionScopes.test.mjs` shows one working. The
 * second is kept as margin against one specific, plausible change: allowing a
 * new recording to start while the previous clip is still transcribing. That
 * removes the first bullet, and with it the guarantee that the newest entry is
 * the one being read. Two costs nothing and survives that edit; the honest
 * reason is "a small allowance for a reordering we can name", not a race that
 * exists now.
 *
 * ## Why the cap is safe at all
 *
 * Not because of the number. Whatever falls off the end is reported as a miss
 * rather than as the new-conversation draft, and the caller drops the
 * transcript — see `VoiceScopeLookup`.
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
