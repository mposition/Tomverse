ALTER TABLE "ScheduledJobRun"
  ADD COLUMN "autoFixAttemptedAt" TIMESTAMP(3);

CREATE INDEX "ScheduledJobRun_jobKey_status_autoFixAttemptedAt_idx"
  ON "ScheduledJobRun"("jobKey", "status", "autoFixAttemptedAt");
