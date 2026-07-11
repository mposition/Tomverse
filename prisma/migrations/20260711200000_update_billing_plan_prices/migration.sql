UPDATE "BillingPlan"
SET "monthlyPriceCents" = 1500,
    "currency" = 'USD',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'pro';

UPDATE "BillingPlan"
SET "monthlyPriceCents" = 2500,
    "currency" = 'USD',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'max';
