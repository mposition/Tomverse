-- One experiment ceiling and the holds against it.
--
-- Neither table is a credit balance. There is no default amount: a row exists
-- only when a caller supplies a positive limit. The application does not
-- apply this migration as part of writing it.

CREATE TABLE "PinnedDeploymentExperiment" (
    "id" TEXT NOT NULL,
    "limitMicroUsd" BIGINT NOT NULL,
    "spentMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "reservedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinnedDeploymentExperiment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PinnedDeploymentExperiment_limit_check" CHECK ("limitMicroUsd" > 0),
    CONSTRAINT "PinnedDeploymentExperiment_spent_check" CHECK ("spentMicroUsd" >= 0),
    CONSTRAINT "PinnedDeploymentExperiment_reserved_check" CHECK ("reservedMicroUsd" >= 0)
);

CREATE TABLE "PinnedDeploymentExperimentHold" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "logicalModelId" TEXT NOT NULL,
    "reservedMicroUsd" BIGINT NOT NULL,
    "settledMicroUsd" BIGINT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PinnedDeploymentExperimentHold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PinnedDeploymentExperimentHold_status_check"
        CHECK ("status" IN ('held', 'settled', 'released', 'occupied')),
    CONSTRAINT "PinnedDeploymentExperimentHold_reserved_check"
        CHECK ("reservedMicroUsd" > 0),
    CONSTRAINT "PinnedDeploymentExperimentHold_settled_check"
        CHECK ("settledMicroUsd" IS NULL OR "settledMicroUsd" >= 0)
);

CREATE INDEX "PinnedDeploymentExperimentHold_experimentId_status_idx"
    ON "PinnedDeploymentExperimentHold"("experimentId", "status");

ALTER TABLE "PinnedDeploymentExperimentHold"
    ADD CONSTRAINT "PinnedDeploymentExperimentHold_experimentId_fkey"
    FOREIGN KEY ("experimentId") REFERENCES "PinnedDeploymentExperiment"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
