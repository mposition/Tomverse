CREATE TABLE "ModelRegistryEntry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiModel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiBaseUrl" TEXT NOT NULL,
    "apiKeyEnvName" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT '',
    "bestFor" TEXT NOT NULL DEFAULT '',
    "minimumPlan" TEXT NOT NULL,
    "usageClass" TEXT NOT NULL,
    "creditWeight" INTEGER NOT NULL,
    "publiclyListed" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'enabled',
    "replacementModelId" TEXT,
    "catalogDeleted" BOOLEAN NOT NULL DEFAULT false,
    "reasoning" TEXT,
    "contextWindowTokens" INTEGER,
    "supportsImage" BOOLEAN NOT NULL DEFAULT false,
    "supportsNativePdf" BOOLEAN NOT NULL DEFAULT false,
    "maxImages" INTEGER,
    "maxBase64ImagePayloadBytes" INTEGER,
    "maxOutputTokens" INTEGER,
    "reservationOutputTokens" INTEGER,
    "inputUsdPerMillionTokens" DOUBLE PRECISION,
    "outputUsdPerMillionTokens" DOUBLE PRECISION,
    "cachedInputPriceMultiplier" DOUBLE PRECISION,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelRegistryEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModelRegistryEntry_provider_sortOrder_idx"
ON "ModelRegistryEntry"("provider", "sortOrder");

CREATE INDEX "ModelRegistryEntry_status_catalogDeleted_idx"
ON "ModelRegistryEntry"("status", "catalogDeleted");

CREATE INDEX "ModelRegistryEntry_publiclyListed_enabled_catalogDeleted_idx"
ON "ModelRegistryEntry"("publiclyListed", "enabled", "catalogDeleted");
