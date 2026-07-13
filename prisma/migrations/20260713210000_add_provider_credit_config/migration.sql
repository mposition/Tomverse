CREATE TABLE "ProviderCreditConfig" (
    "provider" TEXT NOT NULL,
    "creditMicroUsd" BIGINT NOT NULL,
    "usageBaselineMicroUsd" BIGINT NOT NULL,
    "note" TEXT,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderCreditConfig_pkey" PRIMARY KEY ("provider"),
    CONSTRAINT "ProviderCreditConfig_creditMicroUsd_nonnegative" CHECK ("creditMicroUsd" >= 0),
    CONSTRAINT "ProviderCreditConfig_usageBaselineMicroUsd_nonnegative" CHECK ("usageBaselineMicroUsd" >= 0)
);
