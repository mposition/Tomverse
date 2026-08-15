/**
 * Pure decisions behind `scripts/stamp-promotion-metadata.mjs`.
 *
 * Separate from the script for the reason every `*-core.mjs` here is: the
 * script's own body needs Stripe and Prisma to run at all, and the parts worth
 * asserting -- which keys change, and whether a request body could carry
 * anything but metadata -- are functions of plain data.
 */

/**
 * The metadata keys this tool is allowed to touch.
 *
 * `couponMismatches()` and `promotionCodeMismatches()` read exactly these two
 * to decide an object is ours. Anything else in the object's metadata belongs
 * to whoever put it there, and Stripe merges on update, so it survives.
 */
export const STAMPED_KEYS = ["tomversePromotionId", "planId"];

/** The stamp the policy row implies. Never a whole-metadata replacement. */
export const stampFor = (promotionId, planId) => ({
  tomversePromotionId: promotionId,
  planId,
});

/**
 * Which stamp keys this object is missing, or holding a different value for.
 *
 * Reported per key rather than as a boolean so the operator sees that a coupon
 * already carrying the right `tomversePromotionId` is only gaining `planId`,
 * rather than reading the write as "both stamps replaced".
 */
export const stampDiff = (metadata, desired) =>
  STAMPED_KEYS.filter((key) => (metadata?.[key] ?? null) !== desired[key]).map(
    (key) => ({ key, from: metadata?.[key] ?? null, to: desired[key] })
  );

/**
 * The Stripe update body.
 *
 * A function, and the only place a body is built, so "this tool cannot move the
 * discount, the expiry, the redemption cap or the active flag" is a property of
 * one testable expression rather than a promise about how call sites are
 * written.
 */
export const stampRequestBody = (desired) => ({ metadata: desired });
