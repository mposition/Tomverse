-- CreateTable
CREATE TABLE "CreditPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "stripeCheckoutSessionId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeChargeId" TEXT,
    "creditsPurchased" INTEGER NOT NULL,
    "fundedCostMicroUsd" BIGINT NOT NULL,
    "amountPaidCents" INTEGER NOT NULL,
    "refundedAmountCents" INTEGER NOT NULL DEFAULT 0,
    "revokedCredits" INTEGER NOT NULL DEFAULT 0,
    "revokedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'paid',
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreditPurchase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditLot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "source" TEXT NOT NULL,
    "originalCredits" INTEGER NOT NULL,
    "remainingCredits" INTEGER NOT NULL,
    "originalFundedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "remainingFundedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreditLot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditLedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creditLotId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "type" TEXT NOT NULL,
    "creditsDelta" INTEGER NOT NULL,
    "fundedCostMicroUsdDelta" BIGINT NOT NULL DEFAULT 0,
    "balanceAfterCredits" INTEGER NOT NULL,
    "balanceAfterFundedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "reservationId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreditPurchase_stripeCheckoutSessionId_key" ON "CreditPurchase"("stripeCheckoutSessionId");
CREATE UNIQUE INDEX "CreditPurchase_stripePaymentIntentId_key" ON "CreditPurchase"("stripePaymentIntentId");
CREATE UNIQUE INDEX "CreditPurchase_stripeChargeId_key" ON "CreditPurchase"("stripeChargeId");
CREATE INDEX "CreditPurchase_userId_purchasedAt_idx" ON "CreditPurchase"("userId", "purchasedAt");
CREATE INDEX "CreditPurchase_status_purchasedAt_idx" ON "CreditPurchase"("status", "purchasedAt");
CREATE INDEX "CreditPurchase_stripePaymentIntentId_idx" ON "CreditPurchase"("stripePaymentIntentId");
CREATE INDEX "CreditLot_userId_status_expiresAt_idx" ON "CreditLot"("userId", "status", "expiresAt");
CREATE INDEX "CreditLot_purchaseId_idx" ON "CreditLot"("purchaseId");
CREATE INDEX "CreditLedgerEntry_userId_createdAt_idx" ON "CreditLedgerEntry"("userId", "createdAt");
CREATE INDEX "CreditLedgerEntry_creditLotId_createdAt_idx" ON "CreditLedgerEntry"("creditLotId", "createdAt");
CREATE INDEX "CreditLedgerEntry_purchaseId_createdAt_idx" ON "CreditLedgerEntry"("purchaseId", "createdAt");
CREATE INDEX "CreditLedgerEntry_reservationId_idx" ON "CreditLedgerEntry"("reservationId");

ALTER TABLE "CreditPurchase" ADD CONSTRAINT "CreditPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditLot" ADD CONSTRAINT "CreditLot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditLot" ADD CONSTRAINT "CreditLot_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "CreditPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_creditLotId_fkey" FOREIGN KEY ("creditLotId") REFERENCES "CreditLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "CreditPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
