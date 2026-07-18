CREATE TABLE "AdminOperationalCheckpoint" (
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "observedAt" TIMESTAMP(3),
  "nextDueAt" TIMESTAMP(3),
  "detail" TEXT,
  "evidenceUrl" TEXT,
  "updatedById" TEXT,
  "updatedByEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminOperationalCheckpoint_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "AdminOperationalCheckpoint_status_nextDueAt_idx" ON "AdminOperationalCheckpoint"("status", "nextDueAt");
CREATE INDEX "AdminOperationalCheckpoint_updatedAt_idx" ON "AdminOperationalCheckpoint"("updatedAt");

CREATE TABLE "PrivacyRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "email" TEXT NOT NULL,
  "requestType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "dueAt" TIMESTAMP(3) NOT NULL,
  "legalHold" BOOLEAN NOT NULL DEFAULT false,
  "legalHoldReason" TEXT,
  "note" TEXT,
  "completedAt" TIMESTAMP(3),
  "handledById" TEXT,
  "handledByEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PrivacyRequest" ADD CONSTRAINT "PrivacyRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PrivacyRequest_status_dueAt_idx" ON "PrivacyRequest"("status", "dueAt");
CREATE INDEX "PrivacyRequest_userId_createdAt_idx" ON "PrivacyRequest"("userId", "createdAt");
CREATE INDEX "PrivacyRequest_email_createdAt_idx" ON "PrivacyRequest"("email", "createdAt");
CREATE INDEX "PrivacyRequest_legalHold_dueAt_idx" ON "PrivacyRequest"("legalHold", "dueAt");
