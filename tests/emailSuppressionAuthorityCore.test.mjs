import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isActiveCause,
  releasableBy,
  removalNeedsApproval,
} from "../lib/emailSuppressionAuthorityCore.ts";

// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4, as
// amended by deploy D.
//
// The read-authority and parity tests that stood here are deleted rather than
// weakened: deploy D removed the setting, the cutover and the entry-against-
// causes comparison that gated it. A test that keeps exercising a mechanism the
// build no longer has is green and guarding nothing.

const now = new Date("2026-09-17T00:00:00.000Z");

test("the release matrix is per cause, not an ordering", () => {
  assert.equal(releasableBy("admin", "manual"), true);
  assert.equal(releasableBy("admin", "hard_bounce"), false);
  assert.equal(releasableBy("approved_admin", "hard_bounce"), true);
  assert.equal(releasableBy("approved_admin", "unsubscribe"), false, "an admin never lifts a person's own unsubscribe");
  assert.equal(releasableBy("preference_enabled", "unsubscribe"), true);
  assert.equal(releasableBy("preference_enabled", "manual"), false);
  assert.equal(releasableBy("delivered", "soft_bounce"), true);
  assert.equal(releasableBy("expiry", "complaint"), false);
  for (const action of ["admin", "approved_admin", "preference_enabled", "delivered", "expiry"]) {
    assert.equal(releasableBy(action, "privacy_request"), false, action);
  }
});

test("a second administrator is needed only for a cause one administrator may not lift", () => {
  assert.equal(removalNeedsApproval(["manual", "soft_bounce"]), false);
  assert.equal(removalNeedsApproval(["manual", "complaint"]), true);
  assert.equal(removalNeedsApproval(["privacy_request"]), false, "nothing to approve that could be lifted");
});

test("an expired or released cause is not active", () => {
  assert.equal(isActiveCause({ releasedAt: null, expiresAt: null }, now), true);
  assert.equal(isActiveCause({ releasedAt: now, expiresAt: null }, now), false);
  assert.equal(isActiveCause({ releasedAt: null, expiresAt: now }, now), false);
});
