CREATE TABLE "RefundRequestTimelineEvent" (
  "id" TEXT NOT NULL,
  "refundRequestId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorEmail" TEXT,
  "eventType" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RefundRequestTimelineEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminProviderIncident" (
  "id" TEXT NOT NULL,
  "provider" TEXT,
  "modelId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'limited',
  "title" TEXT NOT NULL,
  "message" TEXT,
  "fallbackModelIds" TEXT NOT NULL DEFAULT '[]',
  "createdById" TEXT,
  "createdByEmail" TEXT,
  "resolvedById" TEXT,
  "resolvedByEmail" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AdminProviderIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderHealthCheck" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "modelId" TEXT,
  "status" TEXT NOT NULL,
  "latencyMs" INTEGER,
  "errorCode" TEXT,
  "message" TEXT,
  "createdById" TEXT,
  "createdByEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProviderHealthCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RefundRequestTimelineEvent_refundRequestId_createdAt_idx" ON "RefundRequestTimelineEvent"("refundRequestId", "createdAt");
CREATE INDEX "RefundRequestTimelineEvent_eventType_createdAt_idx" ON "RefundRequestTimelineEvent"("eventType", "createdAt");
CREATE INDEX "AdminProviderIncident_status_createdAt_idx" ON "AdminProviderIncident"("status", "createdAt");
CREATE INDEX "AdminProviderIncident_provider_status_idx" ON "AdminProviderIncident"("provider", "status");
CREATE INDEX "AdminProviderIncident_modelId_status_idx" ON "AdminProviderIncident"("modelId", "status");
CREATE INDEX "ProviderHealthCheck_provider_createdAt_idx" ON "ProviderHealthCheck"("provider", "createdAt");
CREATE INDEX "ProviderHealthCheck_status_createdAt_idx" ON "ProviderHealthCheck"("status", "createdAt");

ALTER TABLE "RefundRequestTimelineEvent"
  ADD CONSTRAINT "RefundRequestTimelineEvent_refundRequestId_fkey"
  FOREIGN KEY ("refundRequestId") REFERENCES "RefundRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
