ALTER TABLE "BillingPlan"
  ADD COLUMN "annualPriceCents" INTEGER,
  ADD COLUMN "stripeAnnualPriceId" TEXT;

ALTER TABLE "User"
  ADD COLUMN "subscriptionBillingInterval" TEXT;

UPDATE "BillingPlan"
SET "annualPriceCents" = ROUND("monthlyPriceCents" * 12 * 0.8)::INTEGER
WHERE "annualPriceCents" IS NULL;
