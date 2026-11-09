// The weekly report's traffic and conversion funnel (owner request
// 2026-11-09): posts -> touches -> attributed sign-ups -> first use -> paid,
// per account, against the week before, and the landing experiments a week saw.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_FUNNEL_MIN_SIGNUPS,
  marketingSpanOverlaps,
  marketingWeeklyExperiments,
  summarizeMarketingFunnel,
} from "@/lib/marketingWeeklyFunnelCore";

const accounts = ["instagram-1", "linkedin-1"];

const week = {
  published: [
    { accountSlug: "instagram-1", count: 4 },
    { accountSlug: "linkedin-1", count: 2 },
  ],
  touches: [
    { account: "instagram-1", count: 40 },
    { account: "linkedin-1", count: 10 },
    { account: null, count: 5 },
    { account: "newsletter", count: 3 },
  ],
  signups: [
    { account: "instagram-1", signups: 12, firstUse: 9, paid: 3 },
    { account: null, signups: 2, firstUse: 1, paid: 0 },
  ],
};

const before = {
  published: [{ accountSlug: "instagram-1", count: 2 }],
  touches: [{ account: "instagram-1", count: 20 }],
  signups: [{ account: "instagram-1", signups: 2, firstUse: 2, paid: 0 }],
};

const row = (funnel, key) => funnel.rows.find((entry) => entry.key === key);

test("each account's posts, touches, sign-ups, use and payment, and the rates between them", () => {
  const funnel = summarizeMarketingFunnel({ accounts, current: week, previous: before });
  assert.deepEqual(
    funnel.rows.map((entry) => entry.key),
    ["*", "instagram-1", "linkedin-1", "other"],
  );
  const instagram = row(funnel, "instagram-1");
  assert.equal(instagram.published, 4);
  assert.equal(instagram.touches, 40);
  assert.equal(instagram.signups, 12);
  assert.equal(instagram.firstUse, 9);
  assert.equal(instagram.paid, 3);
  assert.equal(instagram.touchesPerPost, 10);
  assert.equal(instagram.signupRate, 12 / 40);
  assert.equal(instagram.firstUseRate, 9 / 12);
  assert.equal(instagram.paidRate, 3 / 12);
  assert.equal(instagram.held, false);
});

test("the total sums every account and the touches no account's link carried", () => {
  const funnel = summarizeMarketingFunnel({ accounts, current: week, previous: before });
  const total = row(funnel, "*");
  assert.equal(total.published, 6);
  assert.equal(total.touches, 58);
  assert.equal(total.signups, 14);
  assert.equal(total.paid, 3);
  const other = row(funnel, "other");
  assert.equal(other.touches, 8, "a slug that is no account, and no slug, are both other");
  assert.equal(other.signups, 2);
  assert.equal(other.published, null, "nothing is published from other");
  assert.equal(other.touchesPerPost, null);
});

test("a rate with nothing to divide by is none, not zero", () => {
  const funnel = summarizeMarketingFunnel({ accounts, current: week, previous: before });
  const linkedin = row(funnel, "linkedin-1");
  assert.equal(linkedin.signups, 0, "a counted zero stays a zero");
  assert.equal(linkedin.signupRate, 0);
  assert.equal(linkedin.firstUseRate, null);
  assert.equal(linkedin.paidRate, null);
  assert.equal(linkedin.held, true, `fewer than ${MARKETING_FUNNEL_MIN_SIGNUPS} sign-ups is held`);
});

test("the change from the week before, the sign-up rate in percentage points", () => {
  const funnel = summarizeMarketingFunnel({ accounts, current: week, previous: before });
  assert.equal(funnel.previousAvailable, true);
  const instagram = row(funnel, "instagram-1");
  assert.equal(instagram.change.published, 2);
  assert.equal(instagram.change.touches, 20);
  assert.equal(instagram.change.signups, 10);
  assert.equal(instagram.change.paid, 3);
  assert.ok(Math.abs(instagram.change.signupRatePoints - 20) < 1e-9, "30% against 10%");
  const linkedin = row(funnel, "linkedin-1");
  assert.equal(linkedin.change.touches, 10, "nothing the week before is a counted zero");
  assert.equal(linkedin.change.signupRatePoints, null, "no rate the week before, so no change");
});

test("a week before that cannot be read whole gives no change at all", () => {
  const funnel = summarizeMarketingFunnel({ accounts, current: week, previous: null });
  assert.equal(funnel.previousAvailable, false);
  for (const entry of funnel.rows) {
    assert.equal(entry.previous, null);
    assert.deepEqual(entry.change, { published: null, touches: null, signups: null, signupRatePoints: null, paid: null });
  }
});

test("a source that failed to read is null in every cell it feeds, and named", () => {
  const funnel = summarizeMarketingFunnel({
    accounts,
    current: { ...week, touches: null, signups: null },
    previous: before,
  });
  assert.deepEqual(funnel.unread, ["touches", "signups"]);
  const instagram = row(funnel, "instagram-1");
  assert.equal(instagram.published, 4);
  assert.equal(instagram.touches, null);
  assert.equal(instagram.signups, null);
  assert.equal(instagram.touchesPerPost, null);
  assert.equal(instagram.signupRate, null);
  assert.equal(instagram.change.touches, null);
  assert.equal(instagram.held, true);
  assert.equal(row(funnel, "other"), undefined, "an unread remainder has no row");
});

test("other is left out when it has nothing in either week", () => {
  const funnel = summarizeMarketingFunnel({
    accounts,
    current: { published: [], touches: [], signups: [] },
    previous: { published: [], touches: [], signups: [] },
  });
  assert.deepEqual(
    funnel.rows.map((entry) => entry.key),
    ["*", "instagram-1", "linkedin-1"],
  );
});

const window = { start: new Date("2026-11-01T14:00:00.000Z"), end: new Date("2026-11-08T14:00:00.000Z") };

const stored = {
  experimentId: "exp-1",
  bundleId: "hero",
  variantId: "finder",
  status: "running",
  startsAt: "2026-10-28T00:00:00.000Z",
  endsAt: "2026-11-20T00:00:00.000Z",
  stoppedAt: null,
  counts: { controlExposures: 200, controlConversions: 10, variantExposures: 0, variantConversions: 0 },
};

test("the stored experiment shows when its span overlaps the week, with each arm's rate", () => {
  const [entry, ...rest] = marketingWeeklyExperiments({ window, stored, results: [] });
  assert.equal(rest.length, 0);
  assert.equal(entry.experimentId, "exp-1");
  assert.equal(entry.status, "running");
  assert.deepEqual(entry.arms, [
    { arm: "control", exposures: 200, conversions: 10, rate: 0.05 },
    { arm: "finder", exposures: 0, conversions: 0, rate: null },
  ]);
});

test("an experiment outside the week is not shown", () => {
  assert.deepEqual(
    marketingWeeklyExperiments({
      window,
      stored: { ...stored, startsAt: "2026-11-09T00:00:00.000Z" },
      results: [],
    }),
    [],
  );
  assert.deepEqual(
    marketingWeeklyExperiments({ window, stored: { ...stored, stoppedAt: "2026-10-30T00:00:00.000Z" }, results: [] }),
    [],
  );
  assert.equal(marketingSpanOverlaps("not a date", "2026-11-03", window.start, window.end), false);
});

test("a result recorded in the week replaces the live counters of the same experiment", () => {
  const results = [
    { experimentId: "exp-1", variantId: "finder", startedAt: stored.startsAt, endedAt: "2026-11-05T00:00:00.000Z", exposures: 180, conversions: 12 },
    { experimentId: "exp-1", variantId: "control", startedAt: stored.startsAt, endedAt: "2026-11-05T00:00:00.000Z", exposures: 190, conversions: 9 },
    { experimentId: "broken" },
  ];
  const entries = marketingWeeklyExperiments({ window, stored, results });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "result");
  assert.equal(entries[0].bundleId, "hero");
  assert.deepEqual(
    entries[0].arms.map((arm) => [arm.arm, arm.exposures, arm.conversions]),
    [
      ["control", 190, 9],
      ["finder", 180, 12],
    ],
  );
});
