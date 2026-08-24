import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_HALT_SETTING_KEY,
  MARKETING_HEALTH_MINIMUM_EVENTS,
  MARKETING_HEALTH_THRESHOLDS,
  marketingSendHealth,
  parseMarketingHalt,
} from "../lib/marketingSendHealthCore.ts";

// The kill switch §14.5 sets numbers for and nothing implemented (EM-09).
//
// Contract: docs/policy/email-notifications.md §14.5,
// .github/audits/model-lifecycle-email-2026-08-22.md EM-09.

const counts = (overrides = {}) => ({
  sent: 1000,
  bounced: 0,
  complained: 0,
  ...overrides,
});

test("the thresholds are the ones the policy sets", () => {
  // Written down here as well as in the module so a change to either has to be
  // a change to both, and so the numbers in §14.5 can be checked against code
  // without reading it.
  assert.deepEqual(MARKETING_HEALTH_THRESHOLDS, {
    bounce: { warn: 0.02, halt: 0.05 },
    complaint: { warn: 0.001, halt: 0.003 },
  });
});

test("a clean window is ok", () => {
  const verdict = marketingSendHealth(counts());
  assert.equal(verdict.level, "ok");
  assert.equal(verdict.metric, null);
});

test("no sends at all is ok, not a division by zero", () => {
  const verdict = marketingSendHealth({ sent: 0, bounced: 0, complained: 0 });
  assert.equal(verdict.level, "ok");
  assert.equal(verdict.rate, 0);
});

test("a complaint rate over 0.3% halts", () => {
  // 4 in 1000 is 0.4%.
  const verdict = marketingSendHealth(counts({ complained: 4 }));
  assert.equal(verdict.level, "halt");
  assert.equal(verdict.metric, "complaint");
  assert.equal(verdict.observed, 4);
  assert.match(verdict.reason, /0\.40%/);
});

test("a bounce rate over 5% halts", () => {
  const verdict = marketingSendHealth(counts({ bounced: 60 }));
  assert.equal(verdict.level, "halt");
  assert.equal(verdict.metric, "bounce");
});

test("one complaint in a tiny window is not a rate", () => {
  // 1 in 100 is 1%, over three times the halt threshold, and it is one person
  // clicking a button. Halting the stream on it would make the switch useless
  // by making it fire constantly.
  const verdict = marketingSendHealth({ sent: 100, bounced: 0, complained: 1 });
  assert.notEqual(verdict.level, "halt");
  assert.equal(verdict.level, "warning");
});

test("but a small send that draws a pattern still halts", () => {
  // No floor on the denominator, deliberately. Requiring the ~1,000 recipients
  // that make 0.3% arithmetically reachable would mean the switch never fires
  // for a small campaign, which is every campaign this system sends first.
  const verdict = marketingSendHealth({
    sent: 200,
    bounced: 0,
    complained: MARKETING_HEALTH_MINIMUM_EVENTS.complaint,
  });
  assert.equal(verdict.level, "halt");
  assert.equal(verdict.metric, "complaint");
});

test("bounces need more evidence than complaints", () => {
  // A bounce is a full mailbox or somebody's typo; a complaint is a person
  // saying this was spam.
  const belowFloor = marketingSendHealth({ sent: 100, bounced: 9, complained: 0 });
  assert.equal(belowFloor.level, "warning");

  const atFloor = marketingSendHealth({
    sent: 100,
    bounced: MARKETING_HEALTH_MINIMUM_EVENTS.bounce,
    complained: 0,
  });
  assert.equal(atFloor.level, "halt");
});

test("the warning thresholds have no minimum at all", () => {
  // A warning costs a log line and is the signal that arrives before the
  // damage. Gating it would delay the only early notice there is.
  const verdict = marketingSendHealth({ sent: 500, bounced: 0, complained: 1 });
  assert.equal(verdict.level, "warning");
  assert.equal(verdict.metric, "complaint");
});

test("complaints outrank bounces when both are over", () => {
  // A complaint is what closes a sending domain, so it is the one to name.
  const verdict = marketingSendHealth(counts({ bounced: 100, complained: 10 }));
  assert.equal(verdict.level, "halt");
  assert.equal(verdict.metric, "complaint");
});

test("exactly at a threshold does not trip it", () => {
  // The policy says "over". 3 in 1000 is exactly 0.3%.
  const atThreshold = marketingSendHealth(counts({ complained: 3 }));
  assert.notEqual(atThreshold.level, "halt");
});

test("an absent halt setting is not halted", () => {
  for (const raw of [null, undefined, "", "   ", "null"]) {
    assert.equal(parseMarketingHalt(raw).halted, false, JSON.stringify(raw));
  }
});

test("a stored halt reads back whole", () => {
  const stored = JSON.stringify({
    haltedAt: "2026-08-23T00:00:00.000Z",
    metric: "complaint",
    rate: 0.004,
    observed: 4,
    sent: 1000,
    reason: "Complaint rate 0.40% is above the halt threshold.",
  });
  const parsed = parseMarketingHalt(stored);
  assert.equal(parsed.halted, true);
  assert.equal(parsed.state?.metric, "complaint");
  assert.equal(parsed.state?.observed, 4);
});

test("an unreadable halt counts as halted", () => {
  // Fail closed. The alternative to "we cannot tell whether marketing was
  // halted" is sending, and sending is the move that cannot be taken back.
  for (const raw of ["{not json", "[]", '"a string"', "{}", "42"]) {
    assert.equal(parseMarketingHalt(raw).halted, true, raw);
  }
});

test("the setting key is stable", () => {
  // It is what an operator deletes to clear a halt, so it appears in the
  // incident and must not drift from what is stored.
  assert.equal(MARKETING_HALT_SETTING_KEY, "email.marketingHalt");
});
