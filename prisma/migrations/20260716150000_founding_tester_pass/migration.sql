-- Distinguish Stripe-backed discounts from non-renewing internal access passes.
ALTER TABLE "BillingPromotion"
ADD COLUMN "fulfillmentType" TEXT NOT NULL DEFAULT 'stripe_subscription',
ADD COLUMN "accessDurationDays" INTEGER;

ALTER TABLE "BillingPromotionRedemption"
ADD COLUMN "accessStartsAt" TIMESTAMP(3),
ADD COLUMN "accessEndsAt" TIMESTAMP(3),
ADD COLUMN "reminderSentAt" TIMESTAMP(3),
ADD COLUMN "expiredAt" TIMESTAMP(3),
ADD COLUMN "expiryNoticeSentAt" TIMESTAMP(3);

CREATE INDEX "BillingPromotionRedemption_accessEndsAt_reminderSentAt_idx"
ON "BillingPromotionRedemption"("accessEndsAt", "reminderSentAt");

CREATE INDEX "BillingPromotionRedemption_accessEndsAt_expiredAt_idx"
ON "BillingPromotionRedemption"("accessEndsAt", "expiredAt");

-- Founding Tester Pass: Pro access for exactly 60 days, no payment method and
-- no automatic renewal. The end instant is exclusive and corresponds to the
-- end of 2026-08-30 in Brisbane. Limit the private campaign to 25 accounts.
INSERT INTO "BillingPromotion" (
  "id",
  "code",
  "discountPercent",
  "discountAmountCents",
  "maxRedemptions",
  "redeemedCount",
  "durationMonths",
  "fulfillmentType",
  "accessDurationDays",
  "appliesToPlanIds",
  "stripeCouponId",
  "stripePromotionCodeId",
  "startsAt",
  "endsAt",
  "allowAnnualStacking",
  "isActive",
  "createdAt",
  "updatedAt"
)
VALUES (
  'promo_tomfriend100',
  'TOMFRIEND100',
  100,
  NULL,
  25,
  0,
  2,
  'internal_pass',
  60,
  '["pro"]',
  NULL,
  NULL,
  TIMESTAMPTZ '2026-07-16 00:00:00+10',
  TIMESTAMPTZ '2026-08-31 00:00:00+10',
  false,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
  "discountPercent" = EXCLUDED."discountPercent",
  "discountAmountCents" = EXCLUDED."discountAmountCents",
  "maxRedemptions" = EXCLUDED."maxRedemptions",
  "durationMonths" = EXCLUDED."durationMonths",
  "fulfillmentType" = EXCLUDED."fulfillmentType",
  "accessDurationDays" = EXCLUDED."accessDurationDays",
  "appliesToPlanIds" = EXCLUDED."appliesToPlanIds",
  "stripeCouponId" = NULL,
  "stripePromotionCodeId" = NULL,
  "startsAt" = EXCLUDED."startsAt",
  "endsAt" = EXCLUDED."endsAt",
  "allowAnnualStacking" = EXCLUDED."allowAnnualStacking",
  "isActive" = EXCLUDED."isActive",
  "updatedAt" = CURRENT_TIMESTAMP;

-- Preserve already-redeemed friend passes and correct the old one-month grant
-- to exactly 60 days from its original redemption time.
UPDATE "BillingPromotionRedemption" AS redemption
SET
  "billingInterval" = 'internal_pass',
  "accessStartsAt" = COALESCE(redemption."accessStartsAt", redemption."redeemedAt"),
  "accessEndsAt" = COALESCE(
    redemption."accessEndsAt",
    redemption."redeemedAt" + INTERVAL '60 days'
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "BillingPromotion" AS promotion
WHERE redemption."promotionId" = promotion."id"
  AND promotion."code" = 'TOMFRIEND100';

-- Do not overwrite a later Stripe subscription. Only repair the internal
-- zero-dollar activation created by the previous implementation.
UPDATE "User" AS app_user
SET
  "plan" = 'Pro',
  "subscriptionStatus" = 'founding_tester_pass',
  "subscriptionCurrentPeriodEnd" = redemption."accessEndsAt",
  "subscriptionBillingInterval" = NULL,
  "subscriptionCancelAtPeriodEnd" = true
FROM "BillingPromotionRedemption" AS redemption
JOIN "BillingPromotion" AS promotion
  ON promotion."id" = redemption."promotionId"
WHERE app_user."id" = redemption."userId"
  AND promotion."code" = 'TOMFRIEND100'
  AND app_user."stripeSubscriptionId" IS NULL
  AND app_user."subscriptionStatus" IN ('active', 'founding_tester_pass')
  AND redemption."accessEndsAt" > CURRENT_TIMESTAMP;

UPDATE "BillingPromotionRedemption" AS redemption
SET "expiredAt" = COALESCE(redemption."expiredAt", CURRENT_TIMESTAMP)
FROM "BillingPromotion" AS promotion
WHERE redemption."promotionId" = promotion."id"
  AND promotion."code" = 'TOMFRIEND100'
  AND redemption."accessEndsAt" <= CURRENT_TIMESTAMP;

UPDATE "User" AS app_user
SET
  "plan" = 'Free',
  "subscriptionStatus" = 'founding_tester_pass_expired',
  "subscriptionBillingInterval" = NULL,
  "subscriptionCancelAtPeriodEnd" = true
FROM "BillingPromotionRedemption" AS redemption
JOIN "BillingPromotion" AS promotion
  ON promotion."id" = redemption."promotionId"
WHERE app_user."id" = redemption."userId"
  AND promotion."code" = 'TOMFRIEND100'
  AND app_user."stripeSubscriptionId" IS NULL
  AND app_user."subscriptionStatus" IN ('active', 'founding_tester_pass')
  AND redemption."accessEndsAt" <= CURRENT_TIMESTAMP;
