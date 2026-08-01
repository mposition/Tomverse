ALTER TABLE "AdminNotificationLog"
  ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "acknowledgedById" TEXT,
  ADD COLUMN "acknowledgedByEmail" TEXT;

CREATE TABLE "StripeWebhookEventLog" (
  "id" TEXT NOT NULL,
  "stripeEventId" TEXT,
  "eventType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "replayedAt" TIMESTAMP(3),
  "replayedById" TEXT,
  "replayedByEmail" TEXT,
  "payloadSummary" JSONB,

  CONSTRAINT "StripeWebhookEventLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminRetentionRun" (
  "id" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "result" JSONB,
  "error" TEXT,
  "createdById" TEXT,
  "createdByEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminRetentionRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminOperationReport" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "recipient" TEXT,
  "createdById" TEXT,
  "createdByEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminOperationReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StripeWebhookEventLog_stripeEventId_key" ON "StripeWebhookEventLog"("stripeEventId");
CREATE INDEX "AdminNotificationLog_acknowledgedAt_idx" ON "AdminNotificationLog"("acknowledgedAt");
CREATE INDEX "StripeWebhookEventLog_status_receivedAt_idx" ON "StripeWebhookEventLog"("status", "receivedAt");
CREATE INDEX "StripeWebhookEventLog_eventType_receivedAt_idx" ON "StripeWebhookEventLog"("eventType", "receivedAt");
CREATE INDEX "AdminRetentionRun_mode_createdAt_idx" ON "AdminRetentionRun"("mode", "createdAt");
CREATE INDEX "AdminRetentionRun_status_createdAt_idx" ON "AdminRetentionRun"("status", "createdAt");
CREATE INDEX "AdminOperationReport_status_createdAt_idx" ON "AdminOperationReport"("status", "createdAt");
CREATE INDEX "AdminOperationReport_createdById_createdAt_idx" ON "AdminOperationReport"("createdById", "createdAt");
