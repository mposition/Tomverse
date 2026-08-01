CREATE TABLE "ProviderErrorEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "phase" TEXT NOT NULL,
    "diagnosticCode" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "errorName" TEXT,
    "errorCode" TEXT,
    "httpStatus" INTEGER,
    "retryable" BOOLEAN,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderErrorEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InfrastructureCreditConfig" (
    "service" TEXT NOT NULL,
    "creditMicroUsd" BIGINT NOT NULL,
    "note" TEXT,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfrastructureCreditConfig_pkey" PRIMARY KEY ("service")
);

CREATE INDEX "ProviderErrorEvent_provider_createdAt_idx"
ON "ProviderErrorEvent"("provider", "createdAt");

CREATE INDEX "ProviderErrorEvent_provider_diagnosticCode_createdAt_idx"
ON "ProviderErrorEvent"("provider", "diagnosticCode", "createdAt");

CREATE INDEX "ProviderErrorEvent_modelId_createdAt_idx"
ON "ProviderErrorEvent"("modelId", "createdAt");

CREATE INDEX "ProviderErrorEvent_traceId_idx"
ON "ProviderErrorEvent"("traceId");
