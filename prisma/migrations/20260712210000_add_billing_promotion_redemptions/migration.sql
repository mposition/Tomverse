CREATE TABLE "BillingPromotionRedemption" (
  "id" TEXT NOT NULL,
  "promotionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "billingInterval" TEXT NOT NULL,
  "stripeCheckoutSessionId" TEXT,
  "stripeSubscriptionId" TEXT,
  "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingPromotionRedemption_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BillingPromotionRedemption"
  ADD CONSTRAINT "BillingPromotionRedemption_promotionId_fkey"
  FOREIGN KEY ("promotionId")
  REFERENCES "BillingPromotion"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "BillingPromotionRedemption"
  ADD CONSTRAINT "BillingPromotionRedemption_userId_fkey"
  FOREIGN KEY ("userId")
  REFERENCES "User"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

CREATE UNIQUE INDEX "BillingPromotionRedemption_stripeCheckoutSessionId_key"
  ON "BillingPromotionRedemption"("stripeCheckoutSessionId");

CREATE UNIQUE INDEX "BillingPromotionRedemption_promotionId_userId_key"
  ON "BillingPromotionRedemption"("promotionId", "userId");

CREATE INDEX "BillingPromotionRedemption_promotionId_redeemedAt_idx"
  ON "BillingPromotionRedemption"("promotionId", "redeemedAt");

CREATE INDEX "BillingPromotionRedemption_userId_redeemedAt_idx"
  ON "BillingPromotionRedemption"("userId", "redeemedAt");
