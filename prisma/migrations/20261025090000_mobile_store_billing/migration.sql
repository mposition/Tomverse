ALTER TABLE "User" ADD COLUMN "mobileBillingId" TEXT,
  ADD COLUMN "subscriptionStore" TEXT,
  ADD COLUMN "subscriptionStoreProductId" TEXT;
CREATE UNIQUE INDEX "User_mobileBillingId_key" ON "User"("mobileBillingId");
ALTER TABLE "User" ADD COLUMN "webSubscriptionPlan" TEXT,
  ADD COLUMN "storeSubscriptionPlan" TEXT,
  ADD COLUMN "storeSubscriptionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "storeSubscriptionBillingInterval" TEXT,
  ADD COLUMN "storeSubscriptionCancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "storeSubscriptionSyncedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "storeSubscriptionSnapshot" JSONB;
ALTER TABLE "CreditLot" ADD COLUMN "nonExpiring" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "MobileStorePurchaseAuthorization" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "store" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "mobile_store_purchase_auth_lookup_idx"
  ON "MobileStorePurchaseAuthorization"("userId", "store", "productId", "createdAt");
CREATE TABLE "MobileStoreTransaction" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "store" TEXT NOT NULL CHECK ("store" IN ('app_store', 'play_store')),
  "environment" TEXT NOT NULL CHECK ("environment" IN ('PRODUCTION', 'SANDBOX')),
  "transactionId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "packId" TEXT NOT NULL,
  "credits" INTEGER NOT NULL CHECK ("credits" > 0),
  "fundedCostMicroUsd" BIGINT NOT NULL CHECK ("fundedCostMicroUsd" > 0),
  "creditLotId" TEXT,
  "refunded" BOOLEAN NOT NULL DEFAULT false,
  "needsReview" BOOLEAN NOT NULL DEFAULT false,
  "purchasedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MobileStoreTransaction_store_environment_transactionId_key"
  ON "MobileStoreTransaction"("store", "environment", "transactionId");
CREATE UNIQUE INDEX "MobileStoreTransaction_creditLotId_key" ON "MobileStoreTransaction"("creditLotId");
CREATE INDEX "MobileStoreTransaction_userId_purchasedAt_idx" ON "MobileStoreTransaction"("userId", "purchasedAt");
CREATE TABLE "MobileStoreOwnership" (
  "store" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "transactionHash" TEXT NOT NULL,
  "ownerHash" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("store", "environment", "transactionHash")
);
