import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAN_CHANGE_PREVIEW_TTL_MS,
  checkPlanChangeCancellation,
  checkPlanChangePreview,
  describePlanChangeForSupport,
  planChangeIdempotencyKey,
  PLAN_CHANGE_REFUSAL_STATUS,
  planChangeStateFingerprint,
  resolvePlanChange,
  transitionPlanChangeReservation,
} from "../lib/planChangeStateMachine.ts";

const PERIOD_END = new Date("2026-09-01T00:00:00.000Z");

/** An ordinary, changeable Pro monthly subscription. */
const proMonthly = (overrides = {}) => ({
  subscriptionId: "sub_1",
  status: "active",
  tier: "Pro",
  interval: "monthly",
  currency: "usd",
  itemIds: ["si_1"],
  currentPeriodEnd: PERIOD_END,
  cancelAtPeriodEnd: false,
  hasPendingUpdate: false,
  scheduleId: null,
  ...overrides,
});

const maxMonthly = (overrides = {}) =>
  proMonthly({ tier: "Max", ...overrides });

const resolve = (snapshot, targetTier, extra = {}) =>
  resolvePlanChange({
    snapshot,
    targetTier,
    targetInterval: "monthly",
    ...extra,
  });

test("Pro to Max is an immediate upgrade against the single subscription item", () => {
  const result = resolve(proMonthly(), "Max");
  assert.equal(result.allowed, true);
  assert.deepEqual(result.plan, {
    direction: "upgrade",
    execution: "immediate_upgrade",
    fromTier: "Pro",
    toTier: "Max",
    interval: "monthly",
    currency: "usd",
    subscriptionId: "sub_1",
    subscriptionItemId: "si_1",
    // Null, not "now": the entitlement moves when the invoice is paid, and
    // stamping a time here would invite the caller to grant Max before it is.
    effectiveAt: null,
    renewal: "unaffected",
  });
});

test("Max to Pro is reserved for the period boundary, not applied now", () => {
  const result = resolve(maxMonthly(), "Pro");
  assert.equal(result.allowed, true);
  assert.equal(result.plan.direction, "downgrade");
  assert.equal(result.plan.execution, "scheduled_downgrade");
  assert.equal(result.plan.effectiveAt?.toISOString(), PERIOD_END.toISOString());
});

test("execution names what Tomverse does, so no state depends on a Stripe surface", () => {
  // The Customer Portal cannot express the approved downgrade at all, so the
  // model must not have a mode that means "hand it to the Portal".
  const executions = new Set([
    resolve(proMonthly(), "Max").plan.execution,
    resolve(maxMonthly(), "Pro").plan.execution,
  ]);
  assert.deepEqual([...executions].sort(), [
    "immediate_upgrade",
    "scheduled_downgrade",
  ]);
});

test("a cross-interval change is refused in both directions", () => {
  for (const [snapshot, target] of [
    [proMonthly({ interval: "annual" }), "Max"],
    [maxMonthly({ interval: "annual" }), "Pro"],
  ]) {
    const result = resolvePlanChange({
      snapshot,
      targetTier: target,
      targetInterval: "monthly",
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, "BILLING_INTERVAL_CHANGE_NOT_SUPPORTED");
  }

  // Same interval on both sides is what makes it allowed.
  assert.equal(
    resolvePlanChange({
      snapshot: proMonthly({ interval: "annual" }),
      targetTier: "Max",
      targetInterval: "annual",
    }).allowed,
    true
  );
});

test("an unknown interval is refused rather than assumed to match", () => {
  const result = resolve(proMonthly({ interval: null }), "Max");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "BILLING_INTERVAL_CHANGE_NOT_SUPPORTED");
});

test("the same plan is not a change", () => {
  const result = resolve(proMonthly(), "Pro");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "PLAN_CHANGE_NOT_SUPPORTED");
});

test("an account with no subscription is a new purchase, not a change", () => {
  const result = resolve(proMonthly({ subscriptionId: null }), "Max");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "NO_ACTIVE_SUBSCRIPTION");
});

test("past_due is not changeable even though checkout counts it as active", () => {
  // Invoicing an upgrade on an account whose last invoice went unpaid produces
  // a second failed invoice and an entitlement nobody can answer for.
  for (const status of [
    "past_due",
    "incomplete",
    "incomplete_expired",
    "unpaid",
    "paused",
    "canceled",
    null,
  ]) {
    const result = resolve(proMonthly({ status }), "Max");
    assert.equal(result.allowed, false, `status ${status} must be refused`);
    assert.equal(result.code, "SUBSCRIPTION_NOT_CHANGEABLE");
  }

  assert.equal(resolve(proMonthly({ status: "trialing" }), "Max").allowed, true);
});

test("a subscription with more than one item is refused", () => {
  const result = resolve(proMonthly({ itemIds: ["si_1", "si_2"] }), "Max");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "SUBSCRIPTION_NOT_SINGLE_ITEM");

  const empty = resolve(proMonthly({ itemIds: [] }), "Max");
  assert.equal(empty.code, "SUBSCRIPTION_NOT_SINGLE_ITEM");
});

test("a stored Free plan alongside a live subscription is refused, not reconciled here", () => {
  const result = resolve(proMonthly({ tier: "Free" }), "Max");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "SUBSCRIPTION_NOT_CHANGEABLE");
});

test("a change waiting on payment or authentication blocks a second one", () => {
  const result = resolve(proMonthly({ hasPendingUpdate: true }), "Max");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "PLAN_CHANGE_ALREADY_PENDING");
});

test("an already scheduled change blocks another until it is cancelled", () => {
  const reservation = {
    id: "res_1",
    targetTier: "Pro",
    interval: "monthly",
    appliesAt: PERIOD_END,
    status: "pending",
    scheduleId: "sub_sched_1",
  };
  const result = resolve(maxMonthly({ scheduleId: "sub_sched_1" }), "Pro", {
    reservation,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "PLAN_CHANGE_ALREADY_SCHEDULED");
});

test("a schedule this product did not create is a conflict, not something to overwrite", () => {
  const result = resolve(maxMonthly({ scheduleId: "sub_sched_external" }), "Pro");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "SUBSCRIPTION_SCHEDULE_CONFLICT");

  // A settled reservation of ours pointing at the same schedule is not a
  // conflict -- it is our own finished work.
  const settled = resolve(maxMonthly({ scheduleId: "sub_sched_1" }), "Pro", {
    reservation: {
      id: "res_1",
      targetTier: "Pro",
      interval: "monthly",
      appliesAt: PERIOD_END,
      status: "cancelled",
      scheduleId: "sub_sched_1",
    },
  });
  assert.equal(settled.allowed, true);
});

test("an upgrade never clears an end-of-period cancellation on its own", () => {
  const result = resolve(proMonthly({ cancelAtPeriodEnd: true }), "Max");
  assert.equal(result.allowed, true);
  // The change goes ahead -- they get Max for the remaining period they paid
  // for -- but the cancellation stands.
  assert.equal(result.plan.renewal, "cancellation_preserved");
});

test("an explicit renewal opt-in is the only thing that clears a cancellation", () => {
  const result = resolve(proMonthly({ cancelAtPeriodEnd: true }), "Max", {
    resumeRenewal: true,
  });
  assert.equal(result.plan.renewal, "cancellation_cleared_by_explicit_consent");

  // And it is meaningless when there was no cancellation to clear.
  assert.equal(
    resolve(proMonthly(), "Max", { resumeRenewal: true }).plan.renewal,
    "unaffected"
  );
});

test("a downgrade on a cancelling subscription is refused, not silently revived", () => {
  // Reserving Pro for the period after the subscription ends would resurrect a
  // cancelled subscription -- a bigger change than the one requested.
  const result = resolve(maxMonthly({ cancelAtPeriodEnd: true }), "Pro");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "PLAN_CHANGE_BLOCKED_BY_CANCELLATION");
});

test("a downgrade with no known period end has no date to reserve", () => {
  const result = resolve(maxMonthly({ currentPeriodEnd: null }), "Pro");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "SUBSCRIPTION_NOT_CHANGEABLE");

  // An upgrade does not need one: it takes effect on payment.
  assert.equal(resolve(proMonthly({ currentPeriodEnd: null }), "Max").allowed, true);
});

test("an unknown currency is refused rather than guessed", () => {
  const result = resolve(proMonthly({ currency: null }), "Max");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "SUBSCRIPTION_NOT_CHANGEABLE");
});

test("every refusal answers 409, matching the checkout blocks that stay in place", () => {
  assert.equal(PLAN_CHANGE_REFUSAL_STATUS, 409);
});

test("the fingerprint moves when anything the quote depends on moves", () => {
  const base = planChangeStateFingerprint(proMonthly());
  const moved = [
    { status: "trialing" },
    { tier: "Max" },
    { interval: "annual" },
    { currency: "krw" },
    { itemIds: ["si_2"] },
    { currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") },
    { cancelAtPeriodEnd: true },
    { hasPendingUpdate: true },
    { scheduleId: "sub_sched_1" },
    { subscriptionId: "sub_2" },
  ];
  for (const overrides of moved) {
    assert.notEqual(
      planChangeStateFingerprint(proMonthly(overrides)),
      base,
      `${JSON.stringify(overrides)} must change the fingerprint`
    );
  }

  // And it is stable for an unchanged subscription, otherwise every confirm
  // would be rejected as stale.
  assert.equal(planChangeStateFingerprint(proMonthly()), base);
});

test("a confirm is refused once the subscription has moved under the quote", () => {
  const snapshot = proMonthly();
  const now = new Date("2026-08-01T10:00:00.000Z");
  const preview = {
    id: "pcp_1",
    userId: "user_1",
    targetTier: "Max",
    interval: "monthly",
    fingerprint: planChangeStateFingerprint(snapshot),
    createdAt: now,
  };
  const args = {
    preview,
    userId: "user_1",
    targetTier: "Max",
    targetInterval: "monthly",
    now,
  };

  assert.deepEqual(checkPlanChangePreview({ ...args, snapshot }), {
    usable: true,
  });

  // A renewal advanced the period between preview and confirm: the amount we
  // showed is not the amount we would charge.
  assert.deepEqual(
    checkPlanChangePreview({
      ...args,
      snapshot: proMonthly({
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
    }),
    { usable: false, reason: "state_changed" }
  );
});

test("a preview expires, and a clock running ahead does not make it eternal", () => {
  const createdAt = new Date("2026-08-01T10:00:00.000Z");
  const snapshot = proMonthly();
  const preview = {
    id: "pcp_1",
    userId: "user_1",
    targetTier: "Max",
    interval: "monthly",
    fingerprint: planChangeStateFingerprint(snapshot),
    createdAt,
  };
  const at = (ms) =>
    checkPlanChangePreview({
      preview,
      snapshot,
      userId: "user_1",
      targetTier: "Max",
      targetInterval: "monthly",
      now: new Date(createdAt.getTime() + ms),
    });

  assert.equal(at(PLAN_CHANGE_PREVIEW_TTL_MS).usable, true);
  assert.deepEqual(at(PLAN_CHANGE_PREVIEW_TTL_MS + 1), {
    usable: false,
    reason: "expired",
  });
  // Written by a clock ahead of ours. Treating a negative age as fresh would
  // make such a preview usable forever.
  assert.deepEqual(at(-1), { usable: false, reason: "expired" });
});

test("a preview cannot be confirmed by another account or for another plan", () => {
  const snapshot = proMonthly();
  const now = new Date("2026-08-01T10:00:00.000Z");
  const preview = {
    id: "pcp_1",
    userId: "user_1",
    targetTier: "Max",
    interval: "monthly",
    fingerprint: planChangeStateFingerprint(snapshot),
    createdAt: now,
  };

  assert.deepEqual(
    checkPlanChangePreview({
      preview,
      snapshot,
      userId: "user_2",
      targetTier: "Max",
      targetInterval: "monthly",
      now,
    }),
    { usable: false, reason: "not_owner" }
  );

  assert.deepEqual(
    checkPlanChangePreview({
      preview,
      snapshot,
      userId: "user_1",
      targetTier: "Pro",
      targetInterval: "monthly",
      now,
    }),
    { usable: false, reason: "different_target" }
  );

  assert.deepEqual(
    checkPlanChangePreview({
      preview,
      snapshot,
      userId: "user_1",
      targetTier: "Max",
      targetInterval: "annual",
      now,
    }),
    { usable: false, reason: "different_target" }
  );
});

test("repeating a confirm reuses one key, and a fresh quote does not", () => {
  assert.equal(planChangeIdempotencyKey("pcp_1"), "plan-change:pcp_1");
  assert.equal(
    planChangeIdempotencyKey("pcp_1"),
    planChangeIdempotencyKey("pcp_1")
  );
  assert.notEqual(
    planChangeIdempotencyKey("pcp_1"),
    planChangeIdempotencyKey("pcp_2")
  );
});

test("a reservation leaves pending exactly once", () => {
  for (const to of ["applied", "cancelled", "expired", "failed"]) {
    assert.deepEqual(
      transitionPlanChangeReservation({ from: "pending", to }),
      { applied: true },
      `pending -> ${to} must be allowed`
    );
  }
});

test("a redelivered webhook cannot drag a settled reservation back", () => {
  // Stripe delivers at-least-once and out of order. Both are ordinary here,
  // and neither may move a terminal reservation.
  assert.deepEqual(
    transitionPlanChangeReservation({ from: "applied", to: "pending" }),
    { applied: false, reason: "terminal_state" }
  );
  assert.deepEqual(
    transitionPlanChangeReservation({ from: "cancelled", to: "applied" }),
    { applied: false, reason: "terminal_state" }
  );
  assert.deepEqual(
    transitionPlanChangeReservation({ from: "failed", to: "applied" }),
    { applied: false, reason: "terminal_state" }
  );
});

test("a duplicate of the transition that already ran is reported apart from a fault", () => {
  // This is the at-least-once redelivery case, not something to alert on.
  assert.deepEqual(
    transitionPlanChangeReservation({ from: "applied", to: "applied" }),
    { applied: false, reason: "already_in_state" }
  );
  assert.deepEqual(
    transitionPlanChangeReservation({ from: "pending", to: "pending" }),
    { applied: false, reason: "already_in_state" }
  );
});

test("a scheduled downgrade is cancellable until the boundary it applies at", () => {
  const reservation = {
    id: "res_1",
    targetTier: "Pro",
    interval: "monthly",
    appliesAt: PERIOD_END,
    status: "pending",
    scheduleId: "sub_sched_1",
  };

  assert.deepEqual(
    checkPlanChangeCancellation({
      reservation,
      now: new Date(PERIOD_END.getTime() - 1),
    }),
    { allowed: true }
  );

  // At the boundary the processor may already have moved the subscription, so
  // accepting a cancellation here would contradict the invoice.
  assert.deepEqual(
    checkPlanChangeCancellation({ reservation, now: PERIOD_END }),
    { allowed: false, code: "PLAN_CHANGE_ALREADY_APPLIED" }
  );
});

test("cancelling a change that is not scheduled says which of the two it is", () => {
  const base = {
    id: "res_1",
    targetTier: "Pro",
    interval: "monthly",
    appliesAt: PERIOD_END,
    scheduleId: "sub_sched_1",
  };
  const now = new Date("2026-08-01T10:00:00.000Z");

  assert.deepEqual(checkPlanChangeCancellation({ reservation: null, now }), {
    allowed: false,
    code: "NO_SCHEDULED_PLAN_CHANGE",
  });
  assert.deepEqual(
    checkPlanChangeCancellation({
      reservation: { ...base, status: "applied" },
      now,
    }),
    { allowed: false, code: "PLAN_CHANGE_ALREADY_APPLIED" }
  );
  assert.deepEqual(
    checkPlanChangeCancellation({
      reservation: { ...base, status: "cancelled" },
      now,
    }),
    { allowed: false, code: "NO_SCHEDULED_PLAN_CHANGE" }
  );
});

test("the support record carries identifiers and no personal data", () => {
  const { plan } = resolve(maxMonthly(), "Pro");
  const described = describePlanChangeForSupport({
    plan,
    previewId: "pcp_1",
    reservationStatus: "pending",
  });

  assert.equal(described.direction, "downgrade");
  assert.equal(described.execution, "scheduled_downgrade");
  assert.equal(described.subscriptionId, "sub_1");
  assert.equal(described.effectiveAt, PERIOD_END.toISOString());
  assert.equal(described.reservationStatus, "pending");

  // Currency stays -- it identifies the subscription, not the customer.
  const serialised = JSON.stringify(described).toLowerCase();
  for (const forbidden of ["email", "@", "name", "amount"]) {
    assert.ok(
      !serialised.includes(forbidden),
      `the support record must not carry ${forbidden}`
    );
  }
});
