import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Contract: docs/policy/plan-change.md section 10. The route writes to Stripe,
// so what is pinned here is the order of its refusals relative to that write.

const source = readFileSync("app/api/billing/cancel-subscription/route.ts", "utf8");
const resume = source.slice(source.indexOf("export async function DELETE"));
const position = (needle) => {
  const index = resume.indexOf(needle);
  assert.ok(index >= 0, `missing: ${needle}`);
  return index;
};

test("resume renewal is its own handler beside the cancellation", () => {
  assert.match(source, /export async function POST\(/);
  assert.match(source, /export async function DELETE\(/);
});

test("every refusal comes before the one Stripe write", () => {
  const write = position("cancel_at_period_end: false");
  for (const refusal of [
    '"NO_ACTIVE_SUBSCRIPTION"',
    '"ACCOUNT_DELETION_PENDING"',
    '"REFUND_REQUEST_PENDING"',
    '"SUBSCRIPTION_NOT_CHANGEABLE"',
  ]) {
    assert.ok(position(refusal) < write, `${refusal} is checked after the write`);
  }
});

test("it decides on the subscription Stripe has now, and is idempotent when already renewing", () => {
  const retrieve = position("stripe.subscriptions.retrieve(");
  const alreadyRenewing = position("if (!current.cancel_at_period_end)");
  const write = position("cancel_at_period_end: false");
  assert.ok(retrieve < alreadyRenewing && alreadyRenewing < write);
  // Only active and trialing subscriptions renew from here.
  assert.match(source, /RESUMABLE_STATUSES = new Set\(\["active", "trialing"\]\)/);
});

test("it never touches the plan, the price or a schedule", () => {
  const update = resume.slice(
    position("stripe.subscriptions.update("),
    position("const periodEnd")
  );
  assert.doesNotMatch(update, /items|price|schedule|proration/);
});
