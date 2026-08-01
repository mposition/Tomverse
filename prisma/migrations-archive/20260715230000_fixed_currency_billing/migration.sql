-- Fixed-currency billing keeps the original Stripe amount and a transaction-time
-- USD revenue snapshot side by side. Amounts are stored in each currency's minor
-- unit; KRW is a zero-decimal currency.
CREATE TABLE "BillingTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "productType" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "billingInterval" TEXT,
    "stripeCheckoutSessionId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeSubscriptionId" TEXT,
    "amountPaidMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amountPaidUsdMicroUsd" BIGINT NOT NULL,
    "usdConversionRate" TEXT,
    "usdConversionSource" TEXT NOT NULL,
    "pricingVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingTransaction_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CreditPurchase"
ADD COLUMN "amountPaidUsdMicroUsd" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "RefundRequest"
ADD COLUMN "refundCurrency" TEXT;

CREATE UNIQUE INDEX "BillingTransaction_stripeCheckoutSessionId_key"
ON "BillingTransaction"("stripeCheckoutSessionId");
CREATE INDEX "BillingTransaction_userId_paidAt_idx"
ON "BillingTransaction"("userId", "paidAt");
CREATE INDEX "BillingTransaction_productType_paidAt_idx"
ON "BillingTransaction"("productType", "paidAt");
CREATE INDEX "BillingTransaction_currency_paidAt_idx"
ON "BillingTransaction"("currency", "paidAt");
CREATE INDEX "BillingTransaction_stripePaymentIntentId_idx"
ON "BillingTransaction"("stripePaymentIntentId");
CREATE INDEX "BillingTransaction_stripeSubscriptionId_idx"
ON "BillingTransaction"("stripeSubscriptionId");

ALTER TABLE "BillingTransaction"
ADD CONSTRAINT "BillingTransaction_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
