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
    '"SUBSCRIPTION_NOT_CHANGEABLE"',
  ]) {
    assert.ok(position(refusal) < write, `${refusal} is checked after the write`);
  }
});

test("it decides on the subscription Stripe has now, and is idempotent when already renewing", () => {
  const retrieve = position("stripe.subscriptions.retrieve(");
  const status = position("RESUMABLE_STATUSES.has(current.status)");
  const alreadyRenewing = position("if (!current.cancel_at_period_end)");
  const write = position("cancel_at_period_end: false");
  // Status before "already renewing": a canceled subscription is not renewing.
  assert.ok(retrieve < status && status < alreadyRenewing && alreadyRenewing < write);
  // Only active and trialing subscriptions renew from here.
  assert.match(source, /RESUMABLE_STATUSES = new Set\(\["active", "trialing"\]\)/);
});

test("a deletion that lands during the write puts the cancellation back", () => {
  // Account deletion schedules the cancellation at Stripe, then records
  // pending_deletion, then asserts the cancellation again. This route re-reads
  // the account after its own write. Between the two, the cancellation wins.
  const write = position("cancel_at_period_end: false");
  const recheck = resume.indexOf('after?.accountStatus === "pending_deletion"', write);
  assert.ok(recheck > write, "no re-read after the write");
  const revert = resume.indexOf("cancel_at_period_end: true", recheck);
  assert.ok(revert > recheck, "no revert after the re-read");

  const deletion = readFileSync("lib/accountDeletion.ts", "utf8");
  const schedule = deletion.slice(deletion.indexOf("export async function scheduleTomverseAccountDeletion"));
  const record = schedule.indexOf('accountStatus: "pending_deletion"');
  const reassert = schedule.indexOf("await scheduleStripeSubscriptionCancellation", record);
  assert.ok(record > 0 && reassert > record, "deletion does not re-assert after its record");
  // A failure of that second write is raised as an operational incident for a
  // person to verify -- not swallowed, and not retried blindly.
  const afterReassert = schedule.slice(reassert, schedule.indexOf("revokeAllUserSessions", reassert));
  assert.match(afterReassert, /ACCOUNT_DELETION_CANCELLATION_REASSERT_FAILED/);
});

test("an already-renewing subscription corrects a stale stored flag", () => {
  const branch = resume.slice(
    position("if (!current.cancel_at_period_end)"),
    position("const subscription = await stripe.subscriptions.update(")
  );
  assert.match(branch, /subscriptionCancelAtPeriodEnd: false/);
});

test("it never touches the plan, the price or a schedule", () => {
  // Every Stripe write in the handler: its parameter object only.
  const writes = resume.split("stripe.subscriptions.update(").slice(1);
  assert.equal(writes.length, 2, "the resume and its revert");
  const update = writes.map((write) => write.slice(0, write.indexOf("});"))).join("\n");
  assert.doesNotMatch(update, /items|price|schedule|proration/);
});
