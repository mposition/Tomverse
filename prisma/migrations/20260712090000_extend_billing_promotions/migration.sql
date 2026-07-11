ALTER TABLE "BillingPromotion"
  ALTER COLUMN "discountPercent" SET DEFAULT 0,
  ADD COLUMN "discountAmountCents" INTEGER,
  ADD COLUMN "maxRedemptions" INTEGER,
  ADD COLUMN "redeemedCount" INTEGER NOT NULL DEFAULT 0;
