UPDATE "BillingPlan"
SET
  "monthlyMessageLimit" = 10000,
  "updatedAt" = NOW()
WHERE "id" = 'max'
  AND "monthlyMessageLimit" = 8000;
