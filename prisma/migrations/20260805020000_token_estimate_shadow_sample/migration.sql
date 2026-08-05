-- Dual-estimate shadow samples for prompt-token estimator calibration (G1).
--
-- Additive only: a new table, no change to any existing one. Nothing reads it
-- yet, and the candidate estimate it carries is never allowed to influence
-- reservation, rejection, routing or a provider call.
--
-- No foreign keys on purpose. This is telemetry, and it must never be able to
-- block or cascade against the chat and billing rows it observes; a sample
-- whose attempt has been deleted is simply a sample that stops being joinable.
--
-- "attemptId" is unique so the reservation-time insert and the settlement-time
-- update address one row, and so a retry records a separate sample instead of
-- overwriting the attempt that preceded it.
CREATE TABLE "TokenEstimateShadowSample" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "controlEstimatorVersion" TEXT NOT NULL,
    "controlRawEstimatedInputTokens" INTEGER NOT NULL,
    "candidateEstimatorVersion" TEXT NOT NULL,
    "candidateRawEstimatedInputTokens" INTEGER NOT NULL,
    "reservedInputTokens" INTEGER NOT NULL,
    "tokenizerFamily" TEXT NOT NULL,
    "contentCohort" TEXT NOT NULL,
    "hangulCharacters" INTEGER NOT NULL,
    "hanKanaCharacters" INTEGER NOT NULL,
    "nonCjkBytes" INTEGER NOT NULL,
    "nonCjkSymbolRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "providerReportedInputTokens" INTEGER,
    "inputUsageSource" TEXT NOT NULL DEFAULT 'missing',
    "outcome" TEXT NOT NULL DEFAULT 'failed',
    "isPartial" BOOLEAN NOT NULL DEFAULT false,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "isFallbackAttempt" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "TokenEstimateShadowSample_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TokenEstimateShadowSample_attemptId_key"
    ON "TokenEstimateShadowSample"("attemptId");

-- The calibration query's own filter: eligible samples are provider-reported
-- and completed.
CREATE INDEX "TokenEstimateShadowSample_inputUsageSource_outcome_createdAt_idx"
    ON "TokenEstimateShadowSample"("inputUsageSource", "outcome", "createdAt");

-- Family and cohort are how the harness segments its report.
CREATE INDEX "TokenEstimateShadowSample_tokenizerFamily_contentCohort_createdAt_idx"
    ON "TokenEstimateShadowSample"("tokenizerFamily", "contentCohort", "createdAt");

CREATE INDEX "TokenEstimateShadowSample_modelId_createdAt_idx"
    ON "TokenEstimateShadowSample"("modelId", "createdAt");
