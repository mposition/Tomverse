ALTER TABLE "User"
ADD COLUMN "creditDebtCredits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "creditDebtCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "billingRiskStatus" TEXT NOT NULL DEFAULT 'normal',
ADD COLUMN "billingRiskReason" TEXT,
ADD COLUMN "billingRiskAt" TIMESTAMP(3);

ALTER TABLE "CreditPurchase"
ADD COLUMN "unrecoveredCredits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "unrecoveredCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "stripeDisputeId" TEXT,
ADD COLUMN "disputeStatus" TEXT,
ADD COLUMN "disputeAmountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "disputeRevokedCredits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "disputeRevokedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "disputeDebtCredits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "disputeDebtCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "disputeOffsetCredits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "disputeOffsetCostMicroUsd" BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "CreditPurchase_stripeDisputeId_key"
ON "CreditPurchase"("stripeDisputeId");

CREATE TABLE "CreditDebtEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "type" TEXT NOT NULL,
    "creditsDelta" INTEGER NOT NULL,
    "fundedCostMicroUsdDelta" BIGINT NOT NULL DEFAULT 0,
    "balanceAfterCredits" INTEGER NOT NULL,
    "balanceAfterCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditDebtEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreditDebtEntry_userId_createdAt_idx"
ON "CreditDebtEntry"("userId", "createdAt");
CREATE INDEX "CreditDebtEntry_purchaseId_createdAt_idx"
ON "CreditDebtEntry"("purchaseId", "createdAt");
CREATE INDEX "CreditDebtEntry_type_createdAt_idx"
ON "CreditDebtEntry"("type", "createdAt");

ALTER TABLE "CreditDebtEntry"
ADD CONSTRAINT "CreditDebtEntry_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditDebtEntry"
ADD CONSTRAINT "CreditDebtEntry_purchaseId_fkey"
FOREIGN KEY ("purchaseId") REFERENCES "CreditPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
