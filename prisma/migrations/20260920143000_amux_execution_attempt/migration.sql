CREATE TABLE "AmuxExecutionAttempt" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "worker" TEXT NOT NULL,
    "workerInstanceId" TEXT NOT NULL,
    "workerGeneration" INTEGER NOT NULL,
    "taskRevision" INTEGER NOT NULL,

    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    "outcome" TEXT,
    "toStatus" TEXT,
    "endedBy" TEXT,
    "reason" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxExecutionAttempt_pkey"
        PRIMARY KEY ("id"),

    CONSTRAINT "AmuxExecutionAttempt_worker_generation_check"
        CHECK ("workerGeneration" >= 1),

    CONSTRAINT "AmuxExecutionAttempt_task_revision_check"
        CHECK ("taskRevision" >= 0),

    CONSTRAINT "AmuxExecutionAttempt_outcome_check"
        CHECK (
          "outcome" IS NULL
          OR "outcome" IN (
            'succeeded',
            'failed',
            'blocked',
            'expired'
          )
        ),

    CONSTRAINT "AmuxExecutionAttempt_to_status_check"
        CHECK (
          "toStatus" IS NULL
          OR "toStatus" IN (
            'todo',
            'review',
            'done',
            'blocked',
            'cancelled'
          )
        ),

    CONSTRAINT "AmuxExecutionAttempt_lifecycle_check"
        CHECK (
          (
            "endedAt" IS NULL
            AND "outcome" IS NULL
            AND "toStatus" IS NULL
            AND "endedBy" IS NULL
            AND "leaseExpiresAt" IS NOT NULL
          )
          OR
          (
            "endedAt" IS NOT NULL
            AND "outcome" IS NOT NULL
            AND "toStatus" IS NOT NULL
            AND "endedBy" IS NOT NULL
            AND "leaseExpiresAt" IS NULL
          )
        )
);

ALTER TABLE "AmuxExecutionAttempt"
    ADD CONSTRAINT "AmuxExecutionAttempt_taskId_fkey"
    FOREIGN KEY ("taskId")
    REFERENCES "AmuxWorkItem"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

CREATE INDEX "AmuxExecutionAttempt_taskId_startedAt_idx"
    ON "AmuxExecutionAttempt"("taskId", "startedAt");

CREATE INDEX "AmuxExecutionAttempt_worker_endedAt_leaseExpiresAt_idx"
    ON "AmuxExecutionAttempt"(
      "worker",
      "endedAt",
      "leaseExpiresAt"
    );

CREATE INDEX "AmuxExecutionAttempt_workerInstanceId_workerGeneration_idx"
    ON "AmuxExecutionAttempt"(
      "workerInstanceId",
      "workerGeneration"
    );
