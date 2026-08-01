UPDATE "BillingPlan"
SET
  "dailyMessageLimit" = 30,
  "monthlyMessageLimit" = 300,
  "updatedAt" = NOW()
WHERE "id" = 'free';

UPDATE "BillingPlan"
SET
  "dailyMessageLimit" = 150,
  "monthlyMessageLimit" = 3000,
  "updatedAt" = NOW()
WHERE "id" = 'pro';

UPDATE "BillingPlan"
SET
  "dailyMessageLimit" = 0,
  "monthlyMessageLimit" = 8000,
  "updatedAt" = NOW()
WHERE "id" = 'max';
