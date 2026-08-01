-- Public launch offer: 50% off the first monthly billing period for Pro/Max.
-- The end instant is exclusive and corresponds to 2026-08-31 00:00 in Brisbane.
UPDATE "BillingPromotion"
SET
  "discountPercent" = 50,
  "discountAmountCents" = NULL,
  "durationMonths" = 1,
  "appliesToPlanIds" = '["pro","max"]',
  "maxRedemptions" = 100000,
  "startsAt" = TIMESTAMPTZ '2026-07-14 00:00:00+10',
  "endsAt" = TIMESTAMPTZ '2026-08-31 00:00:00+10',
  "allowAnnualStacking" = false,
  "isActive" = true,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'TOMVERSE50';
