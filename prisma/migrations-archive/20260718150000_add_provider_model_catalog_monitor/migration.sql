CREATE TABLE "ProviderModelCatalogEntry" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiModel" TEXT NOT NULL,
    "modelRegistryId" TEXT,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3) NOT NULL,
    "missingSinceAt" TIMESTAMP(3),
    "consecutiveSeen" INTEGER NOT NULL DEFAULT 0,
    "consecutiveMissing" INTEGER NOT NULL DEFAULT 0,
    "lifecycle" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderModelCatalogEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderModelCatalogRun" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "discoveredCount" INTEGER NOT NULL DEFAULT 0,
    "mappedCount" INTEGER NOT NULL DEFAULT 0,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "lifecycleCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderModelCatalogRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderModelCatalogEntry_provider_apiModel_key" ON "ProviderModelCatalogEntry"("provider", "apiModel");
CREATE INDEX "ProviderModelCatalogEntry_provider_status_updatedAt_idx" ON "ProviderModelCatalogEntry"("provider", "status", "updatedAt");
CREATE INDEX "ProviderModelCatalogEntry_modelRegistryId_idx" ON "ProviderModelCatalogEntry"("modelRegistryId");
CREATE INDEX "ProviderModelCatalogEntry_status_lastCheckedAt_idx" ON "ProviderModelCatalogEntry"("status", "lastCheckedAt");
CREATE INDEX "ProviderModelCatalogRun_provider_startedAt_idx" ON "ProviderModelCatalogRun"("provider", "startedAt");
CREATE INDEX "ProviderModelCatalogRun_status_startedAt_idx" ON "ProviderModelCatalogRun"("status", "startedAt");
