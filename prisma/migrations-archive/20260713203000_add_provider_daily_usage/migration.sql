CREATE TABLE "ProviderDailyUsage" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL DEFAULT '__provider__',
    "source" TEXT NOT NULL DEFAULT 'internal',
    "date" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "providerReportedCostMicroUsd" INTEGER,
    "providerReportedUsageJson" JSONB,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderDailyUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderDailyUsage_provider_modelId_source_date_key" ON "ProviderDailyUsage"("provider", "modelId", "source", "date");
CREATE INDEX "ProviderDailyUsage_provider_date_idx" ON "ProviderDailyUsage"("provider", "date");
CREATE INDEX "ProviderDailyUsage_date_idx" ON "ProviderDailyUsage"("date");
CREATE INDEX "ProviderDailyUsage_source_date_idx" ON "ProviderDailyUsage"("source", "date");
