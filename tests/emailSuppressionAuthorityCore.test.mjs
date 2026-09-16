import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isActiveCause,
  releasableBy,
  removalNeedsApproval,
  suppressionParity,
  suppressionReadAuthorityFromValue,
} from "../lib/emailSuppressionAuthorityCore.ts";

// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4.

const now = new Date("2026-09-17T00:00:00.000Z");
const selector = { emailAddress: "a@example.com", scope: "global", purposeKey: "*" };

test("anything but the exact value causes reads as entry", () => {
  assert.equal(suppressionReadAuthorityFromValue("causes"), "causes");
  for (const value of [undefined, null, "", "Causes", "entry", "true", 1]) {
    assert.equal(suppressionReadAuthorityFromValue(value), "entry", String(value));
  }
});

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

test("causes that would let through what the entry stops are unsafe", () => {
  const result = suppressionParity({
    entries: [{ ...selector, reason: "hard_bounce" }],
    causes: [],
    now,
  });
  assert.equal(result.unsafe.length, 4, "every classification the hard bounce stopped");
  assert.equal(result.stricter.length, 0);
});

test("causes that keep a hold the entry's merge overwrote are stricter, not unsafe", () => {
  // The entry was a manual hold, then a complaint overwrote it: transactional
  // passes by the entry. The causes still carry the manual hold.
  const result = suppressionParity({
    entries: [{ ...selector, reason: "complaint", sourceStream: "marketing" }],
    causes: [
      { ...selector, reason: "manual" },
      { ...selector, reason: "complaint", sourceStream: "marketing" },
    ],
    now,
  });
  assert.equal(result.unsafe.length, 0);
  assert.ok(result.stricter.some((finding) => finding.classification === "transactional"));
});

test("an expired entry is compared as absent", () => {
  const result = suppressionParity({
    entries: [{ ...selector, reason: "soft_bounce", expiresAt: new Date(now.getTime() - 1) }],
    causes: [],
    now,
  });
  assert.deepEqual(result, { unsafe: [], stricter: [] });
});
