-- Additive: image billing terms an operator confirms from a measurement in the
-- admin console, and the measurements themselves (image policy section 12.1).
CREATE TABLE "ImageModelBillingTerms" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiModelId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "terms" JSONB NOT NULL,
    "sources" JSONB NOT NULL,
    "measurementId" TEXT,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageModelBillingTerms_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImageBillingMeasurement" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiModelId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "maxCostMicroUsd" INTEGER NOT NULL,
    "spentMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "samples" JSONB NOT NULL,
    "verdict" JSONB,
    "stopReason" TEXT,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ImageBillingMeasurement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImageModelBillingTerms_provider_apiModelId_createdAt_idx" ON "ImageModelBillingTerms"("provider", "apiModelId", "createdAt");
CREATE INDEX "ImageBillingMeasurement_provider_apiModelId_createdAt_idx" ON "ImageBillingMeasurement"("provider", "apiModelId", "createdAt");
CREATE INDEX "ImageBillingMeasurement_status_idx" ON "ImageBillingMeasurement"("status");
