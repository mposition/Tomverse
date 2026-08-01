import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBSCRIPTION_RESYNC_EVENT_TYPES,
  isSubscriptionResyncEvent,
  shouldApplySubscriptionSnapshot,
  subscriptionIdFromEventObject,
} from "../lib/stripeWebhookSyncCore.ts";

test("a snapshot older than what is stored is refused", () => {
  const stored = new Date("2026-08-01T10:00:00.000Z");

  // The defect this exists for: an event generated before a plan change but
  // delivered after it. Applying it silently reverts the account.
  assert.deepEqual(
    shouldApplySubscriptionSnapshot({
      storedObservedAt: stored,
      observedAt: new Date("2026-08-01T09:59:59.000Z"),
    }),
    { apply: false, reason: "stale_observation" }
  );

  assert.deepEqual(
    shouldApplySubscriptionSnapshot({
      storedObservedAt: stored,
      observedAt: new Date("2026-08-01T10:00:01.000Z"),
    }),
    { apply: true, reason: "newer_observation" }
  );
});

test("two reads taken in the same millisecond both apply", () => {
  // They saw the same Stripe state, so neither is stale. Refusing both would
  // drop a legitimate update for no benefit.
  const at = new Date("2026-08-01T10:00:00.000Z");
  assert.equal(
    shouldApplySubscriptionSnapshot({ storedObservedAt: at, observedAt: at })
      .apply,
    true
  );
});

test("an account that has never been synced accepts its first snapshot", () => {
  for (const storedObservedAt of [null, undefined]) {
    assert.deepEqual(
      shouldApplySubscriptionSnapshot({
        storedObservedAt,
        observedAt: new Date("2026-08-01T10:00:00.000Z"),
      }),
      { apply: true, reason: "first_observation" }
    );
  }
});

test("an invoice carries its subscription under parent, not at the top level", () => {
  // This SDK version moved it. Reading the old flat `invoice.subscription`
  // returns undefined, which turns the resync into a silent no-op that looks
  // like it ran -- the exact failure mode this whole change exists to remove.
  const invoice = {
    id: "in_123",
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: "sub_live" },
    },
  };

  assert.equal(subscriptionIdFromEventObject("invoice.paid", invoice), "sub_live");
  assert.equal(
    subscriptionIdFromEventObject("invoice.payment_failed", invoice),
    "sub_live"
  );
  assert.equal(
    subscriptionIdFromEventObject("invoice.payment_action_required", invoice),
    "sub_live"
  );
});

test("an expanded subscription object resolves to its id", () => {
  assert.equal(
    subscriptionIdFromEventObject("invoice.paid", {
      parent: {
        subscription_details: { subscription: { id: "sub_expanded" } },
      },
    }),
    "sub_expanded"
  );
});

test("a pre-2025 invoice payload still resolves", () => {
  // An existing webhook endpoint can be pinned to an older API version, which
  // still sends the flat field.
  assert.equal(
    subscriptionIdFromEventObject("invoice.paid", {
      id: "in_legacy",
      subscription: "sub_legacy",
    }),
    "sub_legacy"
  );
});

test("a subscription event resolves to the subscription itself", () => {
  assert.equal(
    subscriptionIdFromEventObject("customer.subscription.updated", {
      id: "sub_abc",
      customer: "cus_1",
    }),
    "sub_abc"
  );
  assert.equal(
    subscriptionIdFromEventObject("customer.subscription.pending_update_expired", {
      id: "sub_abc",
    }),
    "sub_abc"
  );
});

test("a schedule event resolves to the subscription it drives", () => {
  assert.equal(
    subscriptionIdFromEventObject("subscription_schedule.updated", {
      id: "sub_sched_1",
      subscription: "sub_scheduled",
    }),
    "sub_scheduled"
  );
  // A schedule that has not started yet has no subscription, and there is
  // nothing to resync.
  assert.equal(
    subscriptionIdFromEventObject("subscription_schedule.created", {
      id: "sub_sched_1",
      subscription: null,
    }),
    null
  );
});

test("an unrelated event resolves to nothing", () => {
  assert.equal(
    subscriptionIdFromEventObject("charge.refunded", { id: "ch_1" }),
    null
  );
  assert.equal(subscriptionIdFromEventObject("invoice.paid", null), null);
  assert.equal(subscriptionIdFromEventObject("invoice.paid", "nonsense"), null);
});

test("every event a plan change depends on triggers a resync", () => {
  // These are the events the approved policy names. A missing one means a plan
  // change can complete at Stripe without the product ever noticing.
  for (const eventType of [
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.payment_action_required",
    "customer.subscription.updated",
    "customer.subscription.pending_update_expired",
    "subscription_schedule.updated",
  ]) {
    assert.equal(
      isSubscriptionResyncEvent(eventType),
      true,
      `${eventType} must trigger a resync`
    );
  }

  // Deletion is handled on its own path, and a refund is not a subscription
  // state change.
  assert.equal(isSubscriptionResyncEvent("customer.subscription.deleted"), false);
  assert.equal(isSubscriptionResyncEvent("charge.refunded"), false);
});

test("the resync event list has no duplicates and every entry resolves", () => {
  assert.equal(
    new Set(SUBSCRIPTION_RESYNC_EVENT_TYPES).size,
    SUBSCRIPTION_RESYNC_EVENT_TYPES.length
  );
  // Each listed prefix must be one the extractor actually understands,
  // otherwise the event would be routed to a resync that can never find an id.
  for (const eventType of SUBSCRIPTION_RESYNC_EVENT_TYPES) {
    const resolvable =
      eventType.startsWith("customer.subscription.") ||
      eventType.startsWith("invoice.") ||
      eventType.startsWith("subscription_schedule.");
    assert.ok(resolvable, `${eventType} has no extraction rule`);
  }
});
