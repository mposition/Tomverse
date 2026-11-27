-- Tomverse Desktop cloud execution (docs/ops/desktop-cloud-execution.md),
-- behind TOMVERSE_DESKTOP_CLOUD_EXECUTION_ENABLED (off). One new table; no
-- existing row or column is touched.
--
--   CodeCloudJob  one coding task a runner service runs on a snapshot of the
--                 person's repository that Desktop uploaded as a git bundle.
--                 Holds the person's instruction, the models and credit cap
--                 they approved, the progress lines the runner reported and
--                 where the bundle and the resulting patch are in object
--                 storage (keys derived from the id: code-cloud/<id>/...).
--
-- Money is not here. A job's model calls ride the managed Code reservation
-- ("reservationId" names a CodeTaskReservation by its id, with no foreign key:
-- that table is anonymised, not deleted, when an account goes, and this one
-- is deleted). "billing" is a copy of the reservation's last receipt for
-- display; CodeTaskReservation stays the record.
--
-- Retention: the bundle is removed when the job ends; the row, its lines and
-- its patch are removed seven days later by the maintenance sweep
-- (lib/codeCloudService.ts). An account deletion removes the rows in its own
-- transaction and queues both object keys of every job on the shared object
-- cleanup queue (lib/codeCloudDeletion.ts); the foreign key's cascade is the
-- backstop.
--
-- "runnerTokenHash" is the SHA-256 of the per-claim job token the runner
-- holds; the token itself is never stored and is cleared when the job ends.
--
-- Rollback (nothing else reads this table):
--   DROP TABLE "CodeCloudJob";
BEGIN;

CREATE TABLE "CodeCloudJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientTaskId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "catalogVersion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "executorModelId" TEXT NOT NULL,
    "reviewerModelId" TEXT NOT NULL,
    "approvedCredits" INTEGER NOT NULL,
    "bundleBytes" INTEGER NOT NULL,
    "bundleSha256" TEXT NOT NULL,
    "baseCommit" TEXT NOT NULL,
    "bundleObjectKey" TEXT,
    "reservationId" TEXT,
    "billing" JSONB,
    "runnerId" TEXT,
    "runnerTokenHash" TEXT,
    "runnerLeaseExpiresAt" TIMESTAMPTZ(3),
    "cancelRequestedAt" TIMESTAMPTZ(3),
    "logs" JSONB NOT NULL DEFAULT '[]',
    "logSeq" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "summary" TEXT,
    "patchObjectKey" TEXT,
    "patchBytes" INTEGER,
    "patchSha256" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CodeCloudJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CodeCloudJob_status_check" CHECK ("status" IN ('uploading', 'queued', 'starting', 'running', 'completed', 'failed', 'cancelled')),
    -- The service keeps 400 lines of at most 400 characters; this is the backstop for any other writer.
    CONSTRAINT "CodeCloudJob_logs_check" CHECK (jsonb_typeof("logs") = 'array' AND pg_column_size("logs") <= 524288),
    CONSTRAINT "CodeCloudJob_amounts_check" CHECK ("approvedCredits" > 0 AND "bundleBytes" > 0 AND "logSeq" >= 0 AND ("patchBytes" IS NULL OR "patchBytes" > 0)),
    CONSTRAINT "CodeCloudJob_instruction_check" CHECK (char_length("instruction") BETWEEN 1 AND 16000)
);

CREATE UNIQUE INDEX "CodeCloudJob_userId_clientTaskId_key" ON "CodeCloudJob"("userId", "clientTaskId");
CREATE INDEX "CodeCloudJob_status_createdAt_idx" ON "CodeCloudJob"("status", "createdAt");
CREATE INDEX "CodeCloudJob_userId_createdAt_idx" ON "CodeCloudJob"("userId", "createdAt");
CREATE INDEX "CodeCloudJob_expiresAt_idx" ON "CodeCloudJob"("expiresAt");

ALTER TABLE "CodeCloudJob" ADD CONSTRAINT "CodeCloudJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
