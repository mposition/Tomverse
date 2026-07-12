UPDATE "BillingPromotion"
SET
  "durationMonths" = 1,
  "stripeCouponId" = NULL,
  "stripePromotionCodeId" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'TOMVERSE50'
  AND "durationMonths" <> 1;
