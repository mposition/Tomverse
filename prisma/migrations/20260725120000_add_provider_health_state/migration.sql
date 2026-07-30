CREATE TABLE "ProviderHealthState" (
    "provider" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderHealthState_pkey" PRIMARY KEY ("provider")
);

CREATE INDEX "ProviderHealthState_lastSuccessAt_idx" ON "ProviderHealthState"("lastSuccessAt");
