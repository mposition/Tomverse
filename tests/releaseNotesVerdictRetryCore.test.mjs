// A message whose verdict could not be reached is undecided, not refused.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 7.6, last
// bullet; invariant 11.
//
// The drain has two endings for a message it cannot send -- `skipped` says a
// rule refused it, `failed` says rendering will never work -- and a database
// error while deciding is neither. Before this, an unexpected error became a
// permanent `failed`: a connection reset while reading the country rules retired
// a message the law allows, with `lastErrorKind` naming a Prisma class, and
// nobody reading the row afterwards could tell it from one that was genuinely
// unsendable.

import assert from "node:assert/strict";
import test from "node:test";

import {
  VerdictUnavailableError,
  verdictRetry,
} from "../lib/releaseNotesVerdictRetryCore.ts";
import {
  RETRY_CLASSIFICATIONS,
  STANDARD_RETRY_CURVES,
  standardMaxAttempts,
} from "../lib/standardEmailRetryCore.ts";

const NOW = new Date("2026-10-01T00:00:00.000Z");

test("a first failure reschedules on the classification's own curve", () => {
  for (const classification of RETRY_CLASSIFICATIONS) {
    const decision = verdictRetry({ attemptsMade: 0, classification, now: NOW });
    assert.equal(decision.outcome, "retry", classification);
    assert.equal(decision.attempts, 1);
    // The same curve the send retry uses. A verdict that cannot be reached is
    // not a different kind of wait, and a second curve would be a second thing
    // to keep in step.
    assert.equal(decision.delayMs, STANDARD_RETRY_CURVES[classification][0]);
    assert.equal(
      decision.nextAttemptAt.getTime(),
      NOW.getTime() + STANDARD_RETRY_CURVES[classification][0]
    );
  }
});

test("it runs out where a send runs out, and says why", () => {
  // Retrying for ever is its own failure: a message nobody can decide after
  // every attempt is one an operator has to look at, and `pending` for ever is
  // how nobody does.
  for (const classification of RETRY_CLASSIFICATIONS) {
    const last = standardMaxAttempts(classification) - 1;
    assert.equal(
      verdictRetry({ attemptsMade: last - 1, classification, now: NOW }).outcome,
      "retry",
      `${classification} gave up one attempt early`
    );
    const exhausted = verdictRetry({ attemptsMade: last, classification, now: NOW });
    assert.equal(exhausted.outcome, "abandoned", classification);
    assert.equal(exhausted.attempts, last + 1);
    assert.equal(exhausted.reason, "verdict_unavailable_attempts_exhausted");
  }
});

test("the attempt count moves forward, so the curve cannot stall", () => {
  // The count the drain writes back is this one. Returning the count it was
  // given would leave a message retrying the first delay for ever, which is the
  // shape of a queue that looks busy and never finishes.
  let attempts = 0;
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const decision = verdictRetry({ attemptsMade: attempts, classification: "marketing", now: NOW });
    if (decision.outcome !== "retry") break;
    assert.equal(decision.attempts, attempts + 1);
    attempts = decision.attempts;
    seen.push(decision.delayMs);
  }
  // Marketing has a one-step curve today, so this walks it and stops; the
  // assertion is that each step is the next delay and not the first one again.
  assert.equal(seen.length, STANDARD_RETRY_CURVES.marketing.length);
  assert.deepEqual(seen, [...STANDARD_RETRY_CURVES.marketing]);
  assert.equal(
    verdictRetry({ attemptsMade: attempts, classification: "marketing", now: NOW }).outcome,
    "abandoned"
  );
});

test("the error is a class, because the drain has to tell it from a render failure", () => {
  // Both arrive at the same `catch`. Anything that is not this stays what it
  // was: permanently failed.
  const error = new VerdictUnavailableError("the country rules could not be read", {
    cause: new Error("connection reset"),
  });
  assert.ok(error instanceof VerdictUnavailableError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "VerdictUnavailableError");
  assert.match(error.message, /country rules/);
  assert.match(String(error.cause), /connection reset/);
  assert.ok(!(new Error("render failed") instanceof VerdictUnavailableError));
});
