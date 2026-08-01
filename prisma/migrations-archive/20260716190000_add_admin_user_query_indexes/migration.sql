-- Keep full-database admin user segments and account statistics efficient as
-- the User table grows. These indexes do not change existing records.
CREATE INDEX "User_plan_id_idx" ON "User"("plan", "id");
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");
CREATE INDEX "User_subscriptionStatus_subscriptionCurrentPeriodEnd_idx"
  ON "User"("subscriptionStatus", "subscriptionCurrentPeriodEnd");
CREATE INDEX "User_subscriptionCancelAtPeriodEnd_subscriptionStatus_idx"
  ON "User"("subscriptionCancelAtPeriodEnd", "subscriptionStatus");
CREATE INDEX "User_billingRiskStatus_idx" ON "User"("billingRiskStatus");
CREATE INDEX "User_creditDebtCredits_idx" ON "User"("creditDebtCredits");
CREATE INDEX "User_creditDebtCostMicroUsd_idx" ON "User"("creditDebtCostMicroUsd");
