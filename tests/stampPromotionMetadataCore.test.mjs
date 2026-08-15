import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  STAMPED_KEYS,
  stampDiff,
  stampFor,
  stampRequestBody,
} from "../scripts/stamp-promotion-metadata-core.mjs";

/**
 * The promise `scripts/stamp-promotion-metadata.mjs` makes to an operator.
 *
 * It repairs the production failure behind "This promotion is not currently
 * available." on a promotion that validates: a coupon or promotion code created
 * in the Stripe dashboard carries no `tomversePromotionId` / `planId`, so
 * `couponMismatches()` reports an `identity` mismatch and
 * `canUseStripePromotionCode()` refuses it. The repair is two metadata writes.
 *
 * What has to stay true is the narrowness. The objects it edits may be attached
 * to live subscriptions, and the discount, the expiry and the redemption cap
 * are the fields a customer is billed under. So "this tool cannot move them" is
 * asserted here against the request body itself, not left as a claim in a
 * comment above the call site.
 */

const SCRIPT = "scripts/stamp-promotion-metadata.mjs";
const PROMOTION_ID = "promo_1783819720812";

test("the stamp is exactly the two keys the mismatch checks read", () => {
  assert.deepEqual(STAMPED_KEYS, ["tomversePromotionId", "planId"]);
  assert.deepEqual(stampFor(PROMOTION_ID, "pro"), {
    tomversePromotionId: PROMOTION_ID,
    planId: "pro",
  });
});

test("the request body carries metadata and nothing else", () => {
  // The whole safety argument in one assertion: no `active`, no `expires_at`,
  // no `max_redemptions`, no `percent_off`, no `duration`. A field absent from
  // the body cannot be changed by any invocation.
  const body = stampRequestBody(stampFor(PROMOTION_ID, "pro"));
  assert.deepEqual(Object.keys(body), ["metadata"]);
  assert.deepEqual(Object.keys(body.metadata).sort(), [
    "planId",
    "tomversePromotionId",
  ]);
});

test("an object with no stamp at all reports both keys as absent", () => {
  // The production state: a promotion code made by hand in the dashboard.
  const diff = stampDiff({}, stampFor(PROMOTION_ID, "pro"));
  assert.deepEqual(diff, [
    { key: "tomversePromotionId", from: null, to: PROMOTION_ID },
    { key: "planId", from: null, to: "pro" },
  ]);
});

test("a coupon that predates the planId stamp reports only the key it is missing", () => {
  // Also production: the coupon carried `tomversePromotionId` and was created
  // before `planId` joined the stamp. Reporting "both stamps replaced" here
  // would misdescribe the write to the operator approving it.
  const diff = stampDiff(
    { tomversePromotionId: PROMOTION_ID },
    stampFor(PROMOTION_ID, "pro")
  );
  assert.deepEqual(diff, [{ key: "planId", from: null, to: "pro" }]);
});

test("an already-stamped object proposes no change", () => {
  const desired = stampFor(PROMOTION_ID, "pro");
  assert.deepEqual(stampDiff(desired, desired), []);
});

test("a stamp naming a different plan is reported with its current value", () => {
  const diff = stampDiff(
    { tomversePromotionId: PROMOTION_ID, planId: "max" },
    stampFor(PROMOTION_ID, "pro")
  );
  assert.deepEqual(diff, [{ key: "planId", from: "max", to: "pro" }]);
});

test("unrelated metadata keys are never part of the diff", () => {
  // Stripe merges metadata on update, so a key somebody else set survives the
  // write. It must not show up as something this tool is changing either.
  const diff = stampDiff(
    { campaign: "eddie", tomversePromotionId: PROMOTION_ID, planId: "pro" },
    stampFor(PROMOTION_ID, "pro")
  );
  assert.deepEqual(diff, []);
});

test("the script builds no other Stripe update body", () => {
  // A second call site passing its own object would defeat the body test
  // above, and it would not fail anything else.
  const source = readFileSync(SCRIPT, "utf8");
  const updates = [...source.matchAll(/\.update\(([^;]*?)\)\s*;/gs)];
  assert.ok(updates.length >= 2);
  for (const [, call] of updates) {
    assert.match(call, /stampRequestBody\(desired\)/);
  }
});

test("the script never writes to the database", () => {
  const source = readFileSync(SCRIPT, "utf8");
  for (const method of [
    "prisma.billingPromotion.update",
    "prisma.billingPromotion.updateMany",
    "prisma.billingPromotion.create",
    "$executeRaw",
  ]) {
    assert.equal(source.includes(method), false, `${method} must not appear`);
  }
});

test("the script refuses to stamp anything the database is not already linked to", () => {
  // Adoption by stamping would manufacture the proof of ownership the stamp is
  // supposed to carry: a stranger's code would become ours because we wrote our
  // id onto it. Objects are only ever reached through the stored ids.
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /coupons\s*\n?\s*\.retrieve\(promotion\.stripeCouponId\)/);
  assert.match(
    source,
    /promotionCodes\s*\n?\s*\.retrieve\(promotion\.stripePromotionCodeId\)/
  );
  assert.equal(source.includes("findPromotionCodesByExactCode"), false);
  assert.equal(source.includes("promotionCodes.list"), false);
});

test("the script reads a promotion code's coupon through the shared helper", () => {
  // It hand-rolled `promotionCode.coupon?.id` once, which reads only the field
  // recent API versions moved away from. Against production that yielded no
  // coupon id at all, and the pair guard refused a healthy pair with
  // "attached to coupon -". The extraction has one home for exactly this
  // reason; a second copy is a second chance to read the wrong field.
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /promotionCodeCouponId\(promotionCode\)/);
  assert.match(source, /promotionCodeCouponId\(codeObject\)/);
  assert.equal(/\.coupon\s*===\s*"string"/.test(source), false);
  assert.equal(/\.coupon\?\.id/.test(source), false);
});

test("a snapshot is written before any update under --apply", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const snapshotAt = source.indexOf("writeFileSync(snapshotPath");
  const firstUpdateAt = source.indexOf("stripe.coupons.update");
  assert.ok(snapshotAt > 0 && firstUpdateAt > 0);
  assert.ok(
    snapshotAt < firstUpdateAt,
    "the pre-change metadata must be captured before it is overwritten"
  );
});
