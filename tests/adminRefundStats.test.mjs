import assert from "node:assert/strict";
import test from "node:test";

import {
  aestMonthKey,
  approvedRefundMonths,
  creditUseShare,
  monthKeysEndingAt,
  waitingDays,
} from "../lib/adminRefundStats.ts";

const NOW = "2026-11-07T03:00:00.000Z"; // 13:00 on 7 November in Brisbane

const approved = (reviewedAt, refundAmountCents, refundCurrency = "AUD") => ({
  status: "approved",
  requestedAt: reviewedAt,
  reviewedAt,
  refundAmountCents,
  refundCurrency,
});

test("a month is read on the Brisbane calendar, not the UTC one", () => {
  // 15:00 on 31 October (UTC) is already 1 November in Brisbane (+10).
  assert.equal(aestMonthKey("2026-10-31T15:00:00.000Z"), "2026-11");
  assert.equal(aestMonthKey("2026-10-31T13:59:00.000Z"), "2026-10");
  assert.equal(aestMonthKey("not a date"), null);
  assert.equal(aestMonthKey(null), null);
});

test("the month window runs oldest first and crosses a year end", () => {
  assert.deepEqual(monthKeysEndingAt("2026-02", 4), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.equal(monthKeysEndingAt("2026-13", 3), null);
  assert.equal(monthKeysEndingAt("2026-02", 0), null);
});

test("waiting days are whole days, never negative, and unknown without a clock", () => {
  assert.equal(waitingDays("2026-11-06T03:00:00.000Z", NOW), 1);
  assert.equal(waitingDays("2026-11-07T01:00:00.000Z", NOW), 0);
  assert.equal(waitingDays("2026-11-08T03:00:00.000Z", NOW), 0);
  assert.equal(waitingDays("2026-11-06T03:00:00.000Z", undefined), null);
  assert.equal(waitingDays("garbage", NOW), null);
});

test("approved refunds are counted per month and this month's amounts are kept per currency", () => {
  const months = approvedRefundMonths(
    [
      approved("2026-11-02T01:00:00.000Z", 2900),
      approved("2026-11-05T01:00:00.000Z", 5800),
      approved("2026-11-06T01:00:00.000Z", 1000, "USD"),
      approved("2026-11-06T02:00:00.000Z", null, null),
      approved("2026-09-10T01:00:00.000Z", 900),
      approved("2025-01-10T01:00:00.000Z", 900), // outside the six-month window
      { ...approved("2026-11-03T01:00:00.000Z", 700), status: "rejected" },
      { ...approved("2026-11-03T01:00:00.000Z", 700), status: "pending", reviewedAt: null },
    ],
    NOW
  );
  assert.deepEqual(months.keys, ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(months.counts, [0, 0, 0, 1, 0, 4]);
  assert.equal(months.thisMonth.count, 4);
  assert.deepEqual(months.thisMonth.amounts, [
    { currency: "AUD", minor: 8700 },
    { currency: "USD", minor: 1000 },
  ]);
  assert.equal(months.thisMonth.withoutAmount, 1);
  assert.equal(months.hasData, true);
});

test("with no approved request in the window there is no chart data, and with no clock nothing at all", () => {
  const empty = approvedRefundMonths([{ ...approved("2026-11-03T01:00:00.000Z", 700), status: "pending" }], NOW);
  assert.equal(empty.hasData, false);
  assert.equal(empty.thisMonth.count, 0);
  assert.equal(approvedRefundMonths([], undefined), null);
  assert.equal(approvedRefundMonths([], "garbage"), null);
});

test("a request with no reviewed time is placed by the day it was requested", () => {
  const months = approvedRefundMonths(
    [{ status: "approved", requestedAt: "2026-11-01T01:00:00.000Z", reviewedAt: null, refundAmountCents: 100, refundCurrency: "AUD" }],
    NOW
  );
  assert.equal(months.thisMonth.count, 1);
});

test("the credit share is a percentage of what was bought, none for no purchase, unknown when unread", () => {
  assert.deepEqual(
    creditUseShare({ purchaseCount: 1, purchasedCredits: 8000, remainingCredits: 7520, estimatedUsedCredits: 480 }),
    { kind: "share", percent: 6, used: 480, purchased: 8000 }
  );
  assert.deepEqual(creditUseShare({ purchaseCount: 0, purchasedCredits: 0, remainingCredits: 0, estimatedUsedCredits: 0 }), {
    kind: "none",
  });
  assert.equal(creditUseShare(undefined), null);
  // A purchase with no credits recorded cannot give a share.
  assert.equal(creditUseShare({ purchaseCount: 2, purchasedCredits: 0, remainingCredits: 0, estimatedUsedCredits: 0 }), null);
  assert.equal(
    creditUseShare({ purchaseCount: 1, purchasedCredits: 100, remainingCredits: 0, estimatedUsedCredits: 250 }).percent,
    100
  );
});
