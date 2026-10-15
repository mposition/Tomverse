// What one production webhook event may do to its post (S2 plan, S2f).
//
// The whole table, every status against every derived status, so a change to
// the rule is a change to this test rather than a cell nobody looked at.

import assert from "node:assert/strict";
import test from "node:test";

import { marketingWebhookApplyTransition } from "@/lib/marketingStore";
import { MARKETING_WEBHOOK_DERIVED_STATUS } from "@/lib/marketingWebhookCore";

const STATUSES = [
  "drafted",
  "guard_rejected",
  "pending_approval",
  "approved",
  "rejected",
  "approval_expired",
  "scheduled",
  "publishing",
  "published",
  "verified",
  "outcome_unknown",
  "failed",
  "deleted",
  "removed_by_platform",
];
const DERIVED = [...new Set(Object.values(MARKETING_WEBHOOK_DERIVED_STATUS))].sort();

const expected = (current, derived) => {
  if (current === "outcome_unknown") return { kind: "refuse", code: "outcome_unknown_needs_person" };
  if (current === derived) return { kind: "confirm" };
  if (derived === "removed_by_platform" && (current === "published" || current === "verified")) {
    return { kind: "transition", to: "removed_by_platform" };
  }
  if (derived === "published" && current === "verified") return { kind: "confirm" };
  return { kind: "refuse", code: "transition_not_permitted" };
};

test("every event derives one of the statuses this table covers", () => {
  assert.deepEqual(DERIVED, ["deleted", "failed", "outcome_unknown", "published", "removed_by_platform"]);
});

test("the full table", () => {
  for (const current of STATUSES) {
    for (const derived of DERIVED) {
      assert.deepEqual(
        marketingWebhookApplyTransition(current, derived),
        expected(current, derived),
        `${current} <- ${derived}`,
      );
    }
  }
});

test("the only status an event moves a post to is removed_by_platform, from a live post", () => {
  const moves = [];
  for (const current of STATUSES) {
    for (const derived of DERIVED) {
      const decision = marketingWebhookApplyTransition(current, derived);
      if (decision.kind === "transition") moves.push([current, decision.to]);
    }
  }
  assert.deepEqual(moves, [
    ["published", "removed_by_platform"],
    ["verified", "removed_by_platform"],
  ]);
});

test("an unknown outcome is never resolved by an event, whatever it reports", () => {
  for (const derived of DERIVED) {
    assert.deepEqual(marketingWebhookApplyTransition("outcome_unknown", derived), {
      kind: "refuse",
      code: "outcome_unknown_needs_person",
    });
  }
});
