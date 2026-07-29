import assert from "node:assert/strict";
import test from "node:test";

import { approvalPayloadHash } from "../lib/adminApprovalCore.ts";
import {
  MANUAL_PLAN_ACCESS_DAYS,
  buildPlanAdjustPayload,
  resolveManualPlanPeriodEnd,
} from "../lib/adminPlanAdjustCore.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// The invariant the two-person approval flow depends on. An approval is bound
// to `payloadHash`, and the requester has to re-send the identical body after
// a second administrator approves it -- so anything time-varying in that body
// makes the retry unmatchable and the approval impossible to consume. This is
// exactly what shipped: the console folded `Date.now() + 30 days` into the
// payload, and every retry queued a fresh request instead.
test("the same choices hash identically however much time passes between clicks", () => {
  const choices = {
    plan: "Pro",
    reason: "FINAL-F002 operational verification account",
    confirmText: "ADJUST PLAN",
  };

  const first = approvalPayloadHash(buildPlanAdjustPayload(choices));
  // A second administrator reviews in between, and the requester navigates to
  // the Approvals panel and back -- minutes, and a remount, later.
  const second = approvalPayloadHash(buildPlanAdjustPayload(choices));

  assert.equal(first, second);
});

test("the payload carries no clock-derived field at all", () => {
  const payload = buildPlanAdjustPayload({
    plan: "Max",
    reason: "Billing support recovery",
    confirmText: "ADJUST PLAN",
  });

  assert.deepEqual(Object.keys(payload).sort(), [
    "billingInterval",
    "confirmText",
    "plan",
    "reason",
    "subscriptionStatus",
  ]);
  // A regression here would be a value that looks like a date or a timestamp.
  for (const value of Object.values(payload)) {
    if (typeof value !== "string") continue;
    assert.ok(
      !/\d{4}-\d{2}-\d{2}T/.test(value),
      `payload carries an ISO timestamp: ${value}`
    );
    assert.ok(!/^\d{10,}$/.test(value), `payload carries an epoch: ${value}`);
  }
});

test("a different reason is a different request", () => {
  const base = { plan: "Pro", confirmText: "ADJUST PLAN" };
  assert.notEqual(
    approvalPayloadHash(buildPlanAdjustPayload({ ...base, reason: "Reason one" })),
    approvalPayloadHash(buildPlanAdjustPayload({ ...base, reason: "Reason two" }))
  );
});

test("Free clears the billing interval, paid plans set it monthly", () => {
  assert.equal(
    buildPlanAdjustPayload({ plan: "Free", reason: "Downgrade", confirmText: "ADJUST PLAN" })
      .billingInterval,
    null
  );
  assert.equal(
    buildPlanAdjustPayload({ plan: "Pro", reason: "Upgrade", confirmText: "ADJUST PLAN" })
      .billingInterval,
    "monthly"
  );
});

test("the access window is decided server-side, at execution time", () => {
  const now = new Date("2026-07-29T00:00:00.000Z");

  // Omitted: the caller had no opinion, so the default window applies from the
  // moment the change actually lands -- not from when it was requested.
  assert.equal(
    resolveManualPlanPeriodEnd("Pro", undefined, now)?.toISOString(),
    new Date(now.getTime() + MANUAL_PLAN_ACCESS_DAYS * DAY_MS).toISOString()
  );

  // Explicit values are honoured, including an explicit "no end date".
  assert.equal(
    resolveManualPlanPeriodEnd("Pro", "2026-12-31T00:00:00.000Z", now)?.toISOString(),
    "2026-12-31T00:00:00.000Z"
  );
  assert.equal(resolveManualPlanPeriodEnd("Max", null, now), null);

  // Free never carries one, whatever was passed.
  assert.equal(resolveManualPlanPeriodEnd("Free", undefined, now), null);
  assert.equal(resolveManualPlanPeriodEnd("Free", "2026-12-31T00:00:00.000Z", now), null);
});
