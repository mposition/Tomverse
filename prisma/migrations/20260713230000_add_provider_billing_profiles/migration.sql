CREATE TABLE "ProviderBillingConfig" (
    "provider" TEXT NOT NULL,
    "pricingModel" TEXT NOT NULL,
    "settlementModel" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "monthlyLimitMicroUsd" BIGINT,
    "source" TEXT NOT NULL DEFAULT 'admin_verified',
    "verifiedAt" TIMESTAMP(3),
    "note" TEXT,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderBillingConfig_pkey" PRIMARY KEY ("provider")
);
