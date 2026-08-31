import assert from "node:assert/strict";
import test from "node:test";

import {
  createVoiceSessionScopes,
  voiceSessionBoundaryChanged,
} from "../lib/voiceSessionScopes.ts";

/**
 * The bounded record of which conversation each voice session started in:
 * docs/policy/voice-input.md §8.4.
 *
 * This was a bare `Map` inside `useVoiceRecorder`. Every session added an
 * entry and nothing ever removed one, so a tab left open all day grew one per
 * recording. The retention rule is here, and executed, rather than being a
 * `delete` call at each of the four places a session can end — the sprinkled
 * version only has to miss one of them to be back where it started.
 */

test("a session's scope is returned to it", () => {
  const scopes = createVoiceSessionScopes();
  scopes.remember(1, "conversation-a");

  assert.equal(scopes.scopeFor(1), "conversation-a");
});

test("the new-conversation draft is a scope, not a missing entry", () => {
  // `null` is what `draftKeyFor(null)` means — the new-conversation draft —
  // so it has to survive the round trip as itself.
  const scopes = createVoiceSessionScopes();
  scopes.remember(7, null);

  assert.equal(scopes.scopeFor(7), null);
  assert.equal(scopes.size(), 1);
});

test("an unknown session answers null rather than throwing", () => {
  const scopes = createVoiceSessionScopes();
  assert.equal(scopes.scopeFor(99), null);
});

test("the record stays bounded however many sessions run", () => {
  const scopes = createVoiceSessionScopes();
  for (let sessionId = 1; sessionId <= 500; sessionId++) {
    scopes.remember(sessionId, `conversation-${sessionId}`);
  }

  assert.equal(scopes.size(), 2, "a long-lived tab must not accumulate entries");
});

test("the newest sessions are the ones kept", () => {
  const scopes = createVoiceSessionScopes();
  for (let sessionId = 1; sessionId <= 10; sessionId++) {
    scopes.remember(sessionId, `conversation-${sessionId}`);
  }

  // The current session, and the one before it, so a callback that races a
  // freshly started session still finds its own answer.
  assert.equal(scopes.scopeFor(10), "conversation-10");
  assert.equal(scopes.scopeFor(9), "conversation-9");
  assert.equal(scopes.scopeFor(8), null);
});

test("re-recording the same session id overwrites rather than accumulating", () => {
  const scopes = createVoiceSessionScopes();
  scopes.remember(1, "conversation-a");
  scopes.remember(1, "conversation-b");

  assert.equal(scopes.size(), 1);
  assert.equal(scopes.scopeFor(1), "conversation-b");
});

test("the retention depth is configurable, and one is enough to work", () => {
  const scopes = createVoiceSessionScopes(1);
  scopes.remember(1, "a");
  scopes.remember(2, "b");

  assert.equal(scopes.size(), 1);
  assert.equal(scopes.scopeFor(2), "b");
});

// ---------------------------------------------------------------------------
// The boundary rule: when a running session must end
// ---------------------------------------------------------------------------

const boundary = (overrides) =>
  voiceSessionBoundaryChanged({
    previousScope: "conversation-a",
    nextScope: "conversation-a",
    previousIdentity: "account:user-1",
    nextIdentity: "account:user-1",
    ...overrides,
  });

test("nothing moving is not a change", () => {
  assert.equal(boundary({}), false);
});

test("a conversation switch is a change", () => {
  assert.equal(boundary({ nextScope: "conversation-b" }), true);
});

test("moving to or from the new-conversation draft is a change", () => {
  assert.equal(boundary({ nextScope: null }), true);
  assert.equal(
    boundary({ previousScope: null, nextScope: "conversation-a" }),
    true
  );
});

test("one account replacing another in the same tab is a change", () => {
  // The defect this rule was rewritten for: the identity key used to be
  // "guest" or "account", so account A becoming account B looked identical
  // and a recording made as A could finish into B's draft.
  assert.equal(boundary({ nextIdentity: "account:user-2" }), true);
});

test("a guest signing in is a change", () => {
  assert.equal(
    boundary({ previousIdentity: "guest", nextIdentity: "account:user-1" }),
    true
  );
});

test("signing out is a change", () => {
  assert.equal(
    boundary({ previousIdentity: "account:user-1", nextIdentity: "guest" }),
    true
  );
});

test("an identity that is not known yet is never a change", () => {
  // The session provider settles after hydration, and a refetch can go the
  // other way. Cancelling on either would end a recording the user just
  // started, for no reason they could see.
  assert.equal(boundary({ previousIdentity: null }), false);
  assert.equal(boundary({ nextIdentity: null }), false);
  assert.equal(
    boundary({ previousIdentity: null, nextIdentity: null }),
    false
  );
});

test("an unknown identity does not mask a real conversation switch", () => {
  assert.equal(
    boundary({ previousIdentity: null, nextScope: "conversation-b" }),
    true
  );
});
