-- AlterTable
ALTER TABLE "ProviderHealthState" ADD COLUMN     "consecutiveProbeFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastProbeFailureAt" TIMESTAMP(3),
ADD COLUMN     "lastProbeSuccessAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProviderProbeResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "timedOut" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER,
    "errorClassification" TEXT,
    "diagnosticCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderProbeResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderProbeResult_provider_createdAt_idx" ON "ProviderProbeResult"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderProbeResult_provider_modelId_createdAt_idx" ON "ProviderProbeResult"("provider", "modelId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderProbeResult_runId_idx" ON "ProviderProbeResult"("runId");

-- CreateIndex
CREATE INDEX "ProviderHealthState_lastProbeSuccessAt_idx" ON "ProviderHealthState"("lastProbeSuccessAt");
