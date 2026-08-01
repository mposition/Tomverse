ALTER TABLE "BillingPromotion"
  ADD COLUMN "allowAnnualStacking" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "BillingPromotionRedemption"
  ADD COLUMN "clientIpHash" TEXT,
  ADD COLUMN "paymentMethodFingerprintHash" TEXT,
  ADD COLUMN "riskFlags" TEXT NOT NULL DEFAULT '[]';

-- Active production promotions must be bounded before they can be redeemed.
UPDATE "BillingPromotion"
SET "isActive" = false
WHERE "isActive" = true
  AND ("maxRedemptions" IS NULL OR "endsAt" IS NULL);

CREATE INDEX "BillingPromotionRedemption_promotionId_clientIpHash_redeemedAt_idx"
  ON "BillingPromotionRedemption"("promotionId", "clientIpHash", "redeemedAt");

CREATE INDEX "BillingPromotionRedemption_promotionId_paymentMethodFingerprintHash_redeemedAt_idx"
  ON "BillingPromotionRedemption"("promotionId", "paymentMethodFingerprintHash", "redeemedAt");
