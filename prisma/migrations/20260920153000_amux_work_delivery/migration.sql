CREATE TABLE "AmuxWorkDelivery" (
    "attemptId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "worker" TEXT NOT NULL,
    "workerInstanceId" TEXT NOT NULL,
    "workerGeneration" INTEGER NOT NULL,
    "taskRevision" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "receiptId" TEXT,
    "leasedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxWorkDelivery_pkey"
      PRIMARY KEY ("attemptId"),

    CONSTRAINT "AmuxWorkDelivery_workerGeneration_check"
      CHECK ("workerGeneration" >= 1),

    CONSTRAINT "AmuxWorkDelivery_taskRevision_check"
      CHECK ("taskRevision" >= 0),

    CONSTRAINT "AmuxWorkDelivery_status_check"
      CHECK (
        "status" IN (
          'queued',
          'leased',
          'acknowledged',
          'cancelled'
        )
      ),

    CONSTRAINT "AmuxWorkDelivery_lifecycle_check"
      CHECK (
        (
          "status" = 'queued'
          AND "receiptId" IS NULL
          AND "leasedAt" IS NULL
          AND "leaseExpiresAt" IS NULL
          AND "acknowledgedAt" IS NULL
          AND "cancelledAt" IS NULL
        )
        OR
        (
          "status" = 'leased'
          AND "receiptId" IS NOT NULL
          AND "leasedAt" IS NOT NULL
          AND "leaseExpiresAt" IS NOT NULL
          AND "acknowledgedAt" IS NULL
          AND "cancelledAt" IS NULL
        )
        OR
        (
          "status" = 'acknowledged'
          AND "receiptId" IS NOT NULL
          AND "leasedAt" IS NOT NULL
          AND "leaseExpiresAt" IS NULL
          AND "acknowledgedAt" IS NOT NULL
          AND "cancelledAt" IS NULL
        )
        OR
        (
          "status" = 'cancelled'
          AND "leaseExpiresAt" IS NULL
          AND "acknowledgedAt" IS NULL
          AND "cancelledAt" IS NOT NULL
        )
      )
);

ALTER TABLE "AmuxWorkDelivery"
    ADD CONSTRAINT "AmuxWorkDelivery_attemptId_fkey"
    FOREIGN KEY ("attemptId")
    REFERENCES "AmuxExecutionAttempt"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

CREATE UNIQUE INDEX "AmuxWorkDelivery_receiptId_key"
    ON "AmuxWorkDelivery"("receiptId");

CREATE INDEX "AmuxWorkDelivery_worker_status_createdAt_idx"
    ON "AmuxWorkDelivery"(
      "worker",
      "status",
      "createdAt"
    );

CREATE INDEX "AmuxWorkDelivery_workerInstanceId_workerGeneration_status_idx"
    ON "AmuxWorkDelivery"(
      "workerInstanceId",
      "workerGeneration",
      "status"
    );

CREATE INDEX "AmuxWorkDelivery_status_leaseExpiresAt_idx"
    ON "AmuxWorkDelivery"(
      "status",
      "leaseExpiresAt"
    );
