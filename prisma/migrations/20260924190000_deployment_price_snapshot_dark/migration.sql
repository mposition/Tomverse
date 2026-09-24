-- A deployment-grain price observation.
--
-- This is not the credit reservation snapshot. Nothing in the runtime
-- inserts a row. Unknown knowledge cannot carry an amount. A stated estimate
-- or a verified price names its amount, currency, source and effective time.
-- The applied flags cannot be true: routing and credit charges do not read
-- this row.
--
-- Rollback: drop the table after confirming no runtime source reads it.

CREATE TABLE "DeploymentPriceSnapshot" (
    "id" TEXT NOT NULL,
    "modelDeploymentId" TEXT NOT NULL,
    "logicalModelId" TEXT NOT NULL,
    "knowledge" TEXT NOT NULL,
    "amount" DECIMAL(20,8),
    "currency" TEXT,
    "source" TEXT,
    "effectiveAt" TIMESTAMP(3),
    "appliedToRouting" BOOLEAN NOT NULL DEFAULT false,
    "appliedToBilling" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentPriceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeploymentPriceSnapshot_modelDeploymentId_effectiveAt_idx"
    ON "DeploymentPriceSnapshot"("modelDeploymentId", "effectiveAt");

ALTER TABLE "DeploymentPriceSnapshot"
    ADD CONSTRAINT "DeploymentPriceSnapshot_modelDeploymentId_fkey"
    FOREIGN KEY ("modelDeploymentId") REFERENCES "ModelDeployment"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "DeploymentPriceSnapshot"
    ADD CONSTRAINT "DeploymentPriceSnapshot_knowledge_check"
    CHECK ("knowledge" IN ('unknown', 'estimate', 'verified'));

ALTER TABLE "DeploymentPriceSnapshot"
    ADD CONSTRAINT "DeploymentPriceSnapshot_not_applied_check"
    CHECK ("appliedToRouting" = false AND "appliedToBilling" = false);

ALTER TABLE "DeploymentPriceSnapshot"
    ADD CONSTRAINT "DeploymentPriceSnapshot_amount_check"
    CHECK (
        (
            "knowledge" = 'unknown'
            AND "amount" IS NULL
            AND length(btrim("logicalModelId")) > 0
            AND length(btrim("modelDeploymentId")) > 0
        )
        OR (
            "knowledge" IN ('estimate', 'verified')
            AND "amount" IS NOT NULL
            AND "amount" >= 0
            AND "currency" IS NOT NULL
            AND length(btrim("currency")) > 0
            AND "source" IS NOT NULL
            AND length(btrim("source")) > 0
            AND "effectiveAt" IS NOT NULL
            AND length(btrim("logicalModelId")) > 0
            AND length(btrim("modelDeploymentId")) > 0
        )
    );
