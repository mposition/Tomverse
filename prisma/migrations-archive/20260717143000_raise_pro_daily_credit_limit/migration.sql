UPDATE "BillingPlan"
SET
    "dailyMessageLimit" = 300,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'pro'
  AND "dailyMessageLimit" < 300;
