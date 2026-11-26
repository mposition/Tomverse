import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// An account scheduled for deletion never renews, whichever order a renewal
// resume and the deletion land at Stripe (docs/policy/plan-change.md
// section 10). The route's own behaviour is exercised in
// tests/server-contract/billing-resume-renewal-route.test.ts; these are the
// two other parties, checked by structure (one call site each) rather than
// by position.

const count = (source, needle) => source.split(needle).length - 1;

test("every subscription resync runs the deletion reconciler once", () => {
  const webhook = readFileSync("lib/stripeWebhookProcessing.ts", "utf8");
  assert.equal(count(webhook, "async function keepDeletionCancellation("), 1);
  assert.equal(count(webhook, "await keepDeletionCancellation("), 1);
  // It re-cancels, and reports what Stripe will keep refusing.
  assert.equal(count(webhook, 'accountStatus: "pending_deletion"'), 1);
  assert.ok(count(webhook, "ACCOUNT_DELETION_CANCELLATION_REASSERT_FAILED") >= 1);
});

test("the deletion flow asserts its cancellation before and after recording pending_deletion", () => {
  const deletion = readFileSync("lib/accountDeletion.ts", "utf8");
  assert.equal(count(deletion, "await scheduleStripeSubscriptionCancellation(user.stripeSubscriptionId);"), 2);
  assert.equal(count(deletion, "ACCOUNT_DELETION_CANCELLATION_REASSERT_FAILED"), 1);
});
