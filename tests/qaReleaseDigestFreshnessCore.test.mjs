import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_STALE_AFTER_MS,
  judgeQaReleaseFreshness,
  qaReleaseStaleReferenceId,
  qaReleaseTransactionFits,
  qaReleaseUtcDateKey,
} from "../lib/qaReleaseDigestFreshnessCore.ts";

const NOW = Date.parse("2026-10-03T07:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const judge = (overrides) =>
  judgeQaReleaseFreshness({
    digestSecretConfigured: true,
    desiredEnabled: true,
    latestDigestCreatedAtMs: NOW - HOUR,
    dbNowMs: NOW,
    ...overrides,
  });

test("the stale threshold is the policy's 28 hours", () => {
  assert.equal(QA_RELEASE_STALE_AFTER_MS, 28 * HOUR);
});

test("recorded off is quiet whatever else is true", () => {
  for (const digestSecretConfigured of [true, false]) {
    for (const latestDigestCreatedAtMs of [null, NOW - HOUR, NOW - 100 * HOUR, NOW + HOUR]) {
      assert.equal(
        judge({ desiredEnabled: false, digestSecretConfigured, latestDigestCreatedAtMs }),
        "operator_disabled",
        `secret=${digestSecretConfigured} latest=${latestDigestCreatedAtMs}`,
      );
    }
  }
});

test("no secret and never recorded as enabled is dark", () => {
  for (const latestDigestCreatedAtMs of [null, NOW - HOUR, NOW - 100 * HOUR]) {
    assert.equal(
      judge({ digestSecretConfigured: false, desiredEnabled: null, latestDigestCreatedAtMs }),
      "dark_not_configured",
    );
  }
});

test("a missing secret while recorded as enabled is reported, not silent", () => {
  assert.equal(judge({ digestSecretConfigured: false, desiredEnabled: true }), "control_mismatch");
  assert.equal(
    judge({ digestSecretConfigured: false, desiredEnabled: true, latestDigestCreatedAtMs: null }),
    "control_mismatch",
  );
});

test("a configured environment with no digest row at all is stale, not quiet", () => {
  assert.equal(judge({ latestDigestCreatedAtMs: null }), "stale");
  assert.equal(judge({ latestDigestCreatedAtMs: null, desiredEnabled: null }), "stale");
});

test("a row turns stale exactly at an age of 28 hours", () => {
  assert.equal(judge({ latestDigestCreatedAtMs: NOW - QA_RELEASE_STALE_AFTER_MS + 1 }), "fresh");
  assert.equal(judge({ latestDigestCreatedAtMs: NOW - QA_RELEASE_STALE_AFTER_MS }), "stale");
  assert.equal(judge({ latestDigestCreatedAtMs: NOW - 400 * 24 * HOUR }), "stale");
  assert.equal(judge({ latestDigestCreatedAtMs: NOW }), "fresh");
});

test("a row dated after the database clock is stale, not healthy", () => {
  assert.equal(judge({ latestDigestCreatedAtMs: NOW + 1 }), "stale");
  assert.equal(judge({ latestDigestCreatedAtMs: NOW + 30 * 24 * HOUR }), "stale");
});

test("an unreadable clock throws instead of reading as fresh", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => judge({ dbNowMs: bad }), RangeError);
    assert.throws(() => judge({ latestDigestCreatedAtMs: bad }), RangeError);
  }
});

test("the alert key is the database clock's UTC date", () => {
  assert.equal(qaReleaseUtcDateKey(NOW), "2026-10-03");
  assert.equal(qaReleaseUtcDateKey(Date.parse("2026-10-02T23:59:59.999Z")), "2026-10-02");
  assert.equal(qaReleaseUtcDateKey(Date.parse("2026-10-03T00:00:00.000Z")), "2026-10-03");
  assert.equal(qaReleaseStaleReferenceId(NOW), "stale:2026-10-03");
  assert.throws(() => qaReleaseUtcDateKey(Number.NaN), RangeError);
});

test("each transaction is judged on the budget left at the moment it opens", () => {
  const budget = 300_000;
  assert.equal(qaReleaseTransactionFits("read", 289_000, budget), true);
  assert.equal(qaReleaseTransactionFits("read", 289_001, budget), false);
  assert.equal(qaReleaseTransactionFits("stale_write", 268_000, budget), true);
  assert.equal(qaReleaseTransactionFits("stale_write", 268_001, budget), false);
  assert.equal(qaReleaseTransactionFits("failure_write", 274_000, budget), true);
  assert.equal(qaReleaseTransactionFits("failure_write", 274_001, budget), false);
});

test("the budget is spent in sequence: a full read leaves less for the write after it", () => {
  const budget = 300_000;
  // Starting at 268 s the stale write would fit on its own, but not after an 11 s read.
  let elapsed = 268_000;
  assert.equal(qaReleaseTransactionFits("read", elapsed, budget), true);
  elapsed += 11_000;
  assert.equal(qaReleaseTransactionFits("stale_write", elapsed, budget), false);
  assert.equal(qaReleaseTransactionFits("failure_write", elapsed, budget), false);
  // The policy's 69 s worst case fits exactly when the round starts with 69 s left.
  elapsed = budget - 69_000;
  assert.equal(qaReleaseTransactionFits("read", elapsed, budget), true);
  elapsed += 11_000;
  assert.equal(qaReleaseTransactionFits("stale_write", elapsed, budget), true);
  elapsed += 32_000;
  assert.equal(qaReleaseTransactionFits("failure_write", elapsed, budget), true);
});

test("the budget is the caller's own deadline, not a constant", () => {
  // The Monitor caller aborts at 120 s: a stale write at 100 s does not fit there.
  assert.equal(qaReleaseTransactionFits("stale_write", 100_000, 120_000), false);
  assert.equal(qaReleaseTransactionFits("stale_write", 88_000, 120_000), true);
});

test("an impossible elapsed time or budget is refused", () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => qaReleaseTransactionFits("read", bad, 300_000), RangeError, String(bad));
  }
  for (const bad of [0, -1, Number.NaN]) {
    assert.throws(() => qaReleaseTransactionFits("read", 0, bad), RangeError, String(bad));
  }
});
