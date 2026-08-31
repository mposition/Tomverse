import assert from "node:assert/strict";
import test from "node:test";

import {
  createVoiceSessionScopes,
  resolveVoiceSessionBoundary,
} from "../lib/voiceSessionScopes.ts";

/**
 * Where each voice session belongs, and when a running one must end:
 * docs/policy/voice-input.md §8.4.
 *
 * Both rules are here because neither can be reached through the hook that
 * uses them — that needs a React renderer — and both were wrong in a way
 * nothing would have noticed until a transcript landed in the wrong draft.
 */

// ---------------------------------------------------------------------------
// The scope record
// ---------------------------------------------------------------------------

test("a session's scope is returned to it", () => {
  const scopes = createVoiceSessionScopes();
  scopes.remember(1, "conversation-a");

  assert.deepEqual(scopes.scopeFor(1), { known: true, scopeId: "conversation-a" });
});

test("the new-conversation draft is a scope, and reads back as one", () => {
  // `null` is what `draftKeyFor(null)` means, so it has to survive the round
  // trip as a *known* scope rather than as an absence.
  const scopes = createVoiceSessionScopes();
  scopes.remember(7, null);

  assert.deepEqual(scopes.scopeFor(7), { known: true, scopeId: null });
});

test("a forgotten session is a miss, never the new-conversation draft", () => {
  // The defect: `scopeFor` answered `null` for a session it no longer held,
  // and `null` is a real scope. A late callback for a pruned session would
  // have written its transcript into the new-conversation draft.
  const scopes = createVoiceSessionScopes();

  assert.deepEqual(scopes.scopeFor(99), { known: false });
  assert.ok(
    !("scopeId" in scopes.scopeFor(99)),
    "a miss must not carry a scope a caller could read"
  );
});

test("the record stays bounded however many sessions run", () => {
  const scopes = createVoiceSessionScopes();
  for (let sessionId = 1; sessionId <= 500; sessionId++) {
    scopes.remember(sessionId, `conversation-${sessionId}`);
  }

  assert.equal(scopes.size(), 2, "a long-lived tab must not accumulate entries");
});

test("sessions 1, 2 and 3: 1 is dropped and says so; 2 keeps its own scope", () => {
  // The exact sequence the review asked for, in the layer that decides it.
  const scopes = createVoiceSessionScopes();
  scopes.remember(1, "conversation-a");
  scopes.remember(2, "conversation-b");
  scopes.remember(3, "conversation-c");

  assert.deepEqual(
    scopes.scopeFor(1),
    { known: false },
    "session 1's late callback has nowhere to write, and must be told so"
  );
  assert.deepEqual(scopes.scopeFor(2), { known: true, scopeId: "conversation-b" });
  assert.deepEqual(scopes.scopeFor(3), { known: true, scopeId: "conversation-c" });
});

test("a dropped session whose scope was the new conversation is still a miss", () => {
  // The case where the two failures would have been indistinguishable.
  const scopes = createVoiceSessionScopes();
  scopes.remember(1, null);
  scopes.remember(2, "conversation-b");
  scopes.remember(3, "conversation-c");

  assert.deepEqual(scopes.scopeFor(1), { known: false });
});

test("re-recording the same session id overwrites rather than accumulating", () => {
  const scopes = createVoiceSessionScopes();
  scopes.remember(1, "conversation-a");
  scopes.remember(1, "conversation-b");

  assert.equal(scopes.size(), 1);
  assert.deepEqual(scopes.scopeFor(1), { known: true, scopeId: "conversation-b" });
});

test("the retention depth is configurable, and one is enough to work", () => {
  const scopes = createVoiceSessionScopes(1);
  scopes.remember(1, "a");
  scopes.remember(2, "b");

  assert.equal(scopes.size(), 1);
  assert.deepEqual(scopes.scopeFor(2), { known: true, scopeId: "b" });
  assert.deepEqual(scopes.scopeFor(1), { known: false });
});

/**
 * The hook's own use of a miss, stated here because the hook cannot be
 * executed: a lookup that is not `known` must produce no write at all.
 */
test("a caller that honours the lookup writes nothing on a miss", () => {
  const scopes = createVoiceSessionScopes(1);
  scopes.remember(1, "conversation-a");
  scopes.remember(2, "conversation-b");

  const writes = [];
  const deliver = (sessionId, transcript) => {
    const lookup = scopes.scopeFor(sessionId);
    if (!lookup.known) return;
    writes.push({ scopeId: lookup.scopeId, transcript });
  };

  deliver(1, "session one's words");
  deliver(2, "session two's words");

  assert.deepEqual(writes, [
    { scopeId: "conversation-b", transcript: "session two's words" },
  ]);
});

// ---------------------------------------------------------------------------
// The boundary rule
// ---------------------------------------------------------------------------

const boundary = (overrides) =>
  resolveVoiceSessionBoundary({
    previousScope: "conversation-a",
    nextScope: "conversation-a",
    lastKnownIdentity: "account:user-1",
    nextIdentity: "account:user-1",
    ...overrides,
  });

test("nothing moving is not a change", () => {
  assert.equal(boundary({}).changed, false);
});

test("a conversation switch is a change", () => {
  assert.equal(boundary({ nextScope: "conversation-b" }).changed, true);
});

test("moving to or from the new-conversation draft is a change", () => {
  assert.equal(boundary({ nextScope: null }).changed, true);
  assert.equal(
    boundary({ previousScope: null, nextScope: "conversation-a" }).changed,
    true
  );
});

test("one account replacing another in the same tab is a change", () => {
  assert.equal(boundary({ nextIdentity: "account:user-2" }).changed, true);
});

test("a guest signing in, and signing out, are changes", () => {
  assert.equal(
    boundary({ lastKnownIdentity: "guest", nextIdentity: "account:user-1" }).changed,
    true
  );
  assert.equal(
    boundary({ lastKnownIdentity: "account:user-1", nextIdentity: "guest" }).changed,
    true
  );
});

/**
 * The four paths the review named, driven as sequences rather than as single
 * comparisons — which is the only way the `A -> null -> B` defect is visible.
 *
 * The second version of this rule stored the `null` as its comparison basis,
 * so `A -> null` and then `null -> B` were both "one side is unknown, not a
 * change" and the account switch went through with a session still running.
 */
const sequence = (identities, scope = "conversation-a") => {
  let lastKnownIdentity = identities[0];
  const changes = [];
  for (const nextIdentity of identities.slice(1)) {
    const result = resolveVoiceSessionBoundary({
      previousScope: scope,
      nextScope: scope,
      lastKnownIdentity,
      nextIdentity,
    });
    lastKnownIdentity = result.identity;
    changes.push(result.changed);
  }
  return { changes, lastKnownIdentity };
};

test("F-2 path: null -> A does not cancel", () => {
  const { changes, lastKnownIdentity } = sequence([null, "account:A"]);

  assert.deepEqual(changes, [false]);
  assert.equal(lastKnownIdentity, "account:A", "A becomes the basis");
});

test("F-2 path: A -> null -> A does not cancel", () => {
  const { changes, lastKnownIdentity } = sequence([
    "account:A",
    null,
    "account:A",
  ]);

  assert.deepEqual(changes, [false, false]);
  assert.equal(lastKnownIdentity, "account:A");
});

test("F-2 path: A -> B cancels", () => {
  const { changes } = sequence(["account:A", "account:B"]);

  assert.deepEqual(changes, [true]);
});

test("F-2 path: A -> null -> B cancels", () => {
  // The defect. Both steps used to report "no change".
  const { changes } = sequence(["account:A", null, "account:B"]);

  assert.deepEqual(
    changes,
    [false, true],
    "the gap is not a change, but it must not erase A as the basis either"
  );
});

test("an unresolved identity never becomes the comparison basis", () => {
  const result = resolveVoiceSessionBoundary({
    previousScope: "conversation-a",
    nextScope: "conversation-a",
    lastKnownIdentity: "account:A",
    nextIdentity: null,
  });

  assert.equal(result.changed, false);
  assert.equal(
    result.identity,
    "account:A",
    "storing the null is what reopened the A -> null -> B hole"
  );
});

test("a long run of unresolved reports still remembers who was signed in", () => {
  const { changes } = sequence([
    "account:A",
    null,
    null,
    null,
    "account:B",
  ]);

  assert.deepEqual(changes, [false, false, false, true]);
});

test("an unknown identity does not mask a real conversation switch", () => {
  assert.equal(
    boundary({ lastKnownIdentity: null, nextScope: "conversation-b" }).changed,
    true
  );
});

test("before any identity is known, nothing is a change on identity alone", () => {
  const result = resolveVoiceSessionBoundary({
    previousScope: "conversation-a",
    nextScope: "conversation-a",
    lastKnownIdentity: null,
    nextIdentity: null,
  });

  assert.equal(result.changed, false);
  assert.equal(result.identity, null);
});
