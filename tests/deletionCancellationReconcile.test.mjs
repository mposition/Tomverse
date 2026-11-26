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

test("one locked reconciler turns a deletion's cancellation back on", () => {
  const reconciler = readFileSync("lib/deletionCancellation.ts", "utf8");
  // The account row is locked across the check and the Stripe write, so a
  // restore (and the customer's renewal resume after it) waits for it. The
  // renewal-invoice stop takes the same lock.
  assert.equal(count(reconciler, "FOR UPDATE`;"), 2);
  assert.equal(count(reconciler, "cancel_at_period_end: true"), 1);
  assert.equal(count(reconciler, "stripe.subscriptions.cancel("), 1);
});

test("a renewal invoice of an account pending deletion is stopped from invoice.created", () => {
  const webhook = readFileSync("lib/stripeWebhookProcessing.ts", "utf8");
  assert.equal(count(webhook, 'case "invoice.created":'), 1);
  assert.equal(count(webhook, "await stopDeletionPendingRenewal({ subscriptionId, invoiceId: invoice.id });"), 1);
  // Only renewals: Stripe holds any invoice's finalization while this event fails.
  assert.equal(count(webhook, 'invoice.billing_reason !== "subscription_cycle"'), 1);
});

test("the webhook, the deletion flow and the resume route all go through it", () => {
  const webhook = readFileSync("lib/stripeWebhookProcessing.ts", "utf8");
  assert.equal(count(webhook, "await keepDeletionCancellation(subscription.id);"), 1);
  assert.equal(count(webhook, "await reconcileDeletionCancellation(subscription, eventType !== null);"), 1);

  const deletion = readFileSync("lib/accountDeletion.ts", "utf8");
  // The first cancellation before pending_deletion is recorded, the locked
  // reconcile after it -- and no unlocked second write.
  assert.equal(count(deletion, "await scheduleStripeSubscriptionCancellation(user.stripeSubscriptionId);"), 1);
  assert.equal(count(deletion, "await keepDeletionCancellation(user.stripeSubscriptionId);"), 1);

  const route = readFileSync("app/api/billing/cancel-subscription/route.ts", "utf8");
  assert.equal(count(route, "await keepDeletionCancellation(subscriptionId);"), 1);
  assert.equal(count(route, "cancel_at_period_end: true"), 1, "only the cancellation POST writes true directly");
});
