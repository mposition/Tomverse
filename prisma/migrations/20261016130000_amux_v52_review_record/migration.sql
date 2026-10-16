CREATE TABLE "AmuxV52ReviewRecord" (
    "attemptId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "jobId" TEXT,
    "baseSha" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "authorVendor" TEXT NOT NULL,
    "reviewerVendors" TEXT[] NOT NULL,
    "touchesContract" BOOLEAN NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxV52ReviewRecord_pkey" PRIMARY KEY ("attemptId"),
    CONSTRAINT "AmuxV52ReviewRecord_verdict_check"
      CHECK ("verdict" IN ('accept', 'reject', 'unknown')),
    CONSTRAINT "AmuxV52ReviewRecord_sha_check"
      CHECK ("baseSha" ~ '^[0-9a-f]{40}$' AND
             "commitSha" ~ '^[0-9a-f]{40}$' AND
             "baseSha" <> "commitSha"),
    CONSTRAINT "AmuxV52ReviewRecord_digest_check"
      CHECK ("requestDigest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "AmuxV52ReviewRecord_jobId_key"
  ON "AmuxV52ReviewRecord"("jobId");
CREATE UNIQUE INDEX "AmuxV52ReviewRecord_auditLogId_key"
  ON "AmuxV52ReviewRecord"("auditLogId");
CREATE UNIQUE INDEX "AmuxV52ReviewRecord_attemptId_taskId_key"
  ON "AmuxV52ReviewRecord"("attemptId", "taskId");
CREATE INDEX "AmuxV52ReviewRecord_taskId_createdAt_idx"
  ON "AmuxV52ReviewRecord"("taskId", "createdAt");

ALTER TABLE "AmuxV52ReviewRecord"
  ADD CONSTRAINT "AmuxV52ReviewRecord_attemptId_taskId_fkey"
  FOREIGN KEY ("attemptId", "taskId")
  REFERENCES "AmuxExecutionAttempt"("id", "taskId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxV52ReviewRecord"
  ADD CONSTRAINT "AmuxV52ReviewRecord_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "AmuxWorkItem"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxV52ReviewRecord"
  ADD CONSTRAINT "AmuxV52ReviewRecord_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
