-- Promotion abuse limits (OZBFREE, 2026-11-20: 41 accounts redeemed a 100%
-- first-month code with four cards). Two per-promotion settings, additive only:
--   maxRedemptionsPerPaymentMethod  accounts one card (Stripe fingerprint) may
--                                   redeem on; NULL = no limit. Existing
--                                   promotions take the default of 3.
--   allowedCountries                JSON array of ISO country codes checked
--                                   against the visitor's IP country; '[]' =
--                                   anywhere, so existing promotions are unchanged.
-- Both columns have constant defaults, so PostgreSQL adds them without
-- rewriting the table.
--
-- Plus an index on BillingPromotionRedemption."stripeSubscriptionId": every
-- subscription sync of a promotion subscription now looks its redemption up
-- by subscription. The table holds one row per redemption, so the build is
-- brief.
--
-- Rollback:
--   DROP INDEX "BillingPromotionRedemption_stripeSubscriptionId_idx";
--   ALTER TABLE "BillingPromotion" DROP COLUMN "maxRedemptionsPerPaymentMethod";
--   ALTER TABLE "BillingPromotion" DROP COLUMN "allowedCountries";
BEGIN;

ALTER TABLE "BillingPromotion"
    ADD COLUMN "maxRedemptionsPerPaymentMethod" INTEGER DEFAULT 3,
    ADD COLUMN "allowedCountries" TEXT NOT NULL DEFAULT '[]';

CREATE INDEX "BillingPromotionRedemption_stripeSubscriptionId_idx"
    ON "BillingPromotionRedemption"("stripeSubscriptionId");

COMMIT;
