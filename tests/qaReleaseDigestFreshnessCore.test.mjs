import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_STALE_AFTER_MS,
  judgeQaReleaseFreshness,
  planQaReleaseFreshnessBudget,
  qaReleaseStaleReferenceId,
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

test("without the digest secret the environment is dark unless recorded as enabled", () => {
  for (const desiredEnabled of [null, false]) {
    for (const latestDigestCreatedAtMs of [null, NOW - HOUR, NOW - 100 * HOUR]) {
      assert.equal(
        judge({ digestSecretConfigured: false, desiredEnabled, latestDigestCreatedAtMs }),
        "dark_not_configured",
        `desiredEnabled=${desiredEnabled} latest=${latestDigestCreatedAtMs}`,
      );
    }
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
  // Covers a fresh activation and the day the last row is purged: neither may
  // fall silent for want of a baseline.
  assert.equal(judge({ latestDigestCreatedAtMs: null }), "stale");
  assert.equal(judge({ latestDigestCreatedAtMs: null, desiredEnabled: null }), "stale");
});

test("a row turns stale exactly at 28 hours", () => {
  assert.equal(judge({ latestDigestCreatedAtMs: NOW - QA_RELEASE_STALE_AFTER_MS + 1 }), "fresh");
  assert.equal(judge({ latestDigestCreatedAtMs: NOW - QA_RELEASE_STALE_AFTER_MS }), "stale");
  assert.equal(judge({ latestDigestCreatedAtMs: NOW - 400 * 24 * HOUR }), "stale");
});

test("a row dated in the future reads as fresh -- the named residual, not a crash", () => {
  assert.equal(judge({ latestDigestCreatedAtMs: NOW + HOUR }), "fresh");
});

test("the alert key is the database clock's UTC date", () => {
  assert.equal(qaReleaseUtcDateKey(NOW), "2026-10-03");
  // 23:59:59.999 UTC is still the same day even where the local date has moved on.
  assert.equal(qaReleaseUtcDateKey(Date.parse("2026-10-02T23:59:59.999Z")), "2026-10-02");
  assert.equal(qaReleaseUtcDateKey(Date.parse("2026-10-03T00:00:00.000Z")), "2026-10-03");
  assert.equal(qaReleaseStaleReferenceId(NOW), "stale:2026-10-03");
  assert.throws(() => qaReleaseUtcDateKey(Number.NaN), RangeError);
});

test("the budget gates match the policy's numbers at their edges", () => {
  // remaining = 300,000 - elapsed; read needs 11 s, stale write 32 s, failure write 26 s.
  assert.deepEqual(planQaReleaseFreshnessBudget(289_001), { kind: "skipped_no_budget" });
  assert.deepEqual(planQaReleaseFreshnessBudget(289_000), { kind: "read_only", failureWriteFits: false });
  assert.deepEqual(planQaReleaseFreshnessBudget(288_000), { kind: "read_only", failureWriteFits: false });
  assert.deepEqual(planQaReleaseFreshnessBudget(274_000), { kind: "read_only", failureWriteFits: true });
  assert.deepEqual(planQaReleaseFreshnessBudget(268_001), { kind: "read_only", failureWriteFits: true });
  assert.deepEqual(planQaReleaseFreshnessBudget(268_000), { kind: "full" });
  assert.deepEqual(planQaReleaseFreshnessBudget(0), { kind: "full" });
});

test("an impossible elapsed time is refused rather than read as a budget", () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => planQaReleaseFreshnessBudget(bad), RangeError, String(bad));
  }
});
