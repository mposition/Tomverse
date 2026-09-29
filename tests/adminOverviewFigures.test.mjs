// A read that failed must not become a number.
//
// Overview ran thirteen independent reads inside one `Promise.all`, so any
// rejection took the whole workspace to the error boundary -- including the
// provider health dashboard, which is the read most likely to fail during a
// provider incident and the reason an operator opened Overview.
//
// Moving to `allSettled` fixes the crash and creates a subtler hazard: `null`
// becomes zero the moment anyone writes `?? 0` to satisfy the compiler, and
// "Paid conversion 0.0%" or "$0 MRR" are claims an operator would act on,
// assembled out of an answer that never arrived. Every assertion below is that
// an unknown input stays unknown.

import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_OVERVIEW_READS,
  adminOverviewFigures,
} from "../lib/adminOverviewFigures.ts";

const ALL_UNREAD = {
  providers: null,
  userStats: null,
  billingPlans: null,
  activePlanGroups: null,
  todayUsageCount: null,
  monthlyUsageCount: null,
  openFeedbackCount: null,
  pendingRefundCount: null,
  approvedRefundCount: null,
  promotionRedemptions: null,
  alertFailureCount: null,
};

const HEALTHY = {
  providers: [
    { status: "available", monthCostMicroUsd: 1_000_000 },
    { status: "available", monthCostMicroUsd: 500_000 },
    { status: "limited", monthCostMicroUsd: 250_000 },
    { status: "outage", monthCostMicroUsd: 0 },
  ],
  userStats: {
    totalAccounts: 200,
    activePaidSubscriptions: 50,
    cancelingSubscriptions: 3,
  },
  billingPlans: [
    { id: "pro", monthlyPriceCents: 2000 },
    { id: "max", monthlyPriceCents: 5000 },
  ],
  activePlanGroups: [
    { plan: "Pro", _count: { _all: 40 } },
    { plan: "Max", _count: { _all: 10 } },
  ],
  todayUsageCount: 120,
  monthlyUsageCount: 3400,
  openFeedbackCount: 2,
  pendingRefundCount: 1,
  approvedRefundCount: 5,
  promotionRedemptions: 7,
  alertFailureCount: 0,
};

test("with every read in, the figures are the ones the page used to compute", () => {
  const f = adminOverviewFigures(HEALTHY);
  assert.deepEqual(f.providers, {
    available: 2,
    limited: 1,
    outage: 1,
    total: 4,
  });
  assert.equal(f.monthSpendMicroUsd, 1_750_000);
  assert.equal(f.totalUsers, 200);
  assert.equal(f.paidUsers, 50);
  assert.equal(f.activeSubscriptions, 50);
  assert.equal(f.cancelAtPeriodEndCount, 3);
  assert.equal(f.activeProCount, 40);
  assert.equal(f.activeMaxCount, 10);
  assert.equal(f.monthlyRevenueCents, 40 * 2000 + 10 * 5000);
  assert.equal(f.paidConversionPercent, 25);
  assert.equal(f.workQueueTotal, 3);
});

test("when nothing could be read, nothing is claimed", () => {
  const f = adminOverviewFigures(ALL_UNREAD);
  for (const [key, value] of Object.entries(f)) {
    assert.equal(value, null, `${key} invented a value from no input`);
  }
});

test("a failed provider read costs the provider figures and nothing else", () => {
  // The case that motivated the change: the dashboard is the read most likely
  // to fail during an incident, and it used to take the page with it.
  const f = adminOverviewFigures({ ...HEALTHY, providers: null });
  assert.equal(f.providers, null);
  assert.equal(f.monthSpendMicroUsd, null);
  // Everything not derived from it survives.
  assert.equal(f.totalUsers, 200);
  assert.equal(f.monthlyRevenueCents, 40 * 2000 + 10 * 5000);
  assert.equal(f.workQueueTotal, 3);
});

test("a ratio with an unknown side is unknown, never 0.0", () => {
  assert.equal(
    adminOverviewFigures({ ...HEALTHY, userStats: null }).paidConversionPercent,
    null
  );
  assert.equal(
    adminOverviewFigures({ ...HEALTHY, approvedRefundCount: null })
      .refundRatePercent,
    null
  );
  assert.equal(
    adminOverviewFigures({ ...HEALTHY, userStats: null }).refundRatePercent,
    null
  );
});

test("no accounts at all is unknown rather than zero per cent", () => {
  // A zero denominator is not a ratio. The old code answered "0.0%", which
  // reads as "nobody converts" rather than "there is nobody yet".
  const f = adminOverviewFigures({
    ...HEALTHY,
    userStats: {
      totalAccounts: 0,
      activePaidSubscriptions: 0,
      cancelingSubscriptions: 0,
    },
  });
  assert.equal(f.paidConversionPercent, null);
});

test("the revenue estimate needs both the mix and the price list", () => {
  assert.equal(
    adminOverviewFigures({ ...HEALTHY, billingPlans: null })
      .monthlyRevenueCents,
    null
  );
  assert.equal(
    adminOverviewFigures({ ...HEALTHY, activePlanGroups: null })
      .monthlyRevenueCents,
    null
  );
  // But a failed price read leaves the plan mix intact -- they are separate
  // reads and only one of them is needed to say how many accounts are on Max.
  const withoutPrices = adminOverviewFigures({
    ...HEALTHY,
    billingPlans: null,
  });
  assert.equal(withoutPrices.activeProCount, 40);
  assert.equal(withoutPrices.activeMaxCount, 10);
});

test("the work queue total needs both of its parts", () => {
  assert.equal(
    adminOverviewFigures({ ...HEALTHY, openFeedbackCount: null })
      .workQueueTotal,
    null
  );
  assert.equal(
    adminOverviewFigures({ ...HEALTHY, pendingRefundCount: null })
      .workQueueTotal,
    null
  );
  // Half a total is worse than none: "1 item waiting" when the other half is
  // unknown sends an operator away from a queue that may be deep.
});

test("a plan nobody is on is zero, because the read succeeded", () => {
  // The distinction the whole module is about: a successful read returning no
  // rows really is zero, and must not be reported as unknown.
  const f = adminOverviewFigures({ ...HEALTHY, activePlanGroups: [] });
  assert.equal(f.activeProCount, 0);
  assert.equal(f.activeMaxCount, 0);
  assert.equal(f.monthlyRevenueCents, 0);
});

test("no providers configured is zero providers, not an unknown platform", () => {
  const f = adminOverviewFigures({ ...HEALTHY, providers: [] });
  assert.deepEqual(f.providers, {
    available: 0,
    limited: 0,
    outage: 0,
    total: 0,
  });
  assert.equal(f.monthSpendMicroUsd, 0);
});

test("every read the page makes has a name it can be reported by", () => {
  assert.ok(ADMIN_OVERVIEW_READS.length >= 12);
  assert.equal(
    new Set(ADMIN_OVERVIEW_READS).size,
    ADMIN_OVERVIEW_READS.length,
    "two reads share a name, so a failure report would be ambiguous"
  );
});

test("one failed read at a time never turns another figure into a number", () => {
  // Exhaustive rather than illustrative: for each input, drop only that one and
  // check that every figure is either unchanged or null. Nothing may *appear*.
  const baseline = adminOverviewFigures(HEALTHY);
  for (const key of Object.keys(ALL_UNREAD)) {
    const degraded = adminOverviewFigures({ ...HEALTHY, [key]: null });
    for (const [figure, value] of Object.entries(degraded)) {
      if (value === null) continue;
      assert.deepEqual(
        value,
        baseline[figure],
        `dropping ${key} changed ${figure} to a different non-null value`
      );
    }
  }
});
