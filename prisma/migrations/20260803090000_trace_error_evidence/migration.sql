-- Trace-based error report observability (Phase 1).
--
-- Feedback gains the verification outcome of the server-issued error report
-- token and an optional link to one evidence occurrence. All columns are
-- nullable: existing rows predate the feature and simply have no verified
-- trace. The raw token is never stored.
ALTER TABLE "Feedback" ADD COLUMN "errorReportVerification" TEXT;
ALTER TABLE "Feedback" ADD COLUMN "traceProvenance" TEXT;
ALTER TABLE "Feedback" ADD COLUMN "errorClassificationSource" TEXT;
ALTER TABLE "Feedback" ADD COLUMN "clientErrorCode" TEXT;
ALTER TABLE "Feedback" ADD COLUMN "evidenceAvailability" TEXT;
ALTER TABLE "Feedback" ADD COLUMN "traceEvidenceId" TEXT;

CREATE INDEX "Feedback_traceId_idx" ON "Feedback"("traceId");

-- One row per server-side error occurrence on a server-generated trace.
-- The trace ID is a non-unique index on purpose: trace strings can be
-- client-influenced elsewhere in the system, so identity lives in the
-- server-minted id/occurrenceId, never in the trace.
CREATE TABLE "TraceErrorEvidence" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "traceProvenance" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "release" TEXT,
    "routeClass" TEXT NOT NULL,
    "phase" TEXT,
    "errorCode" TEXT,
    "classificationSource" TEXT NOT NULL DEFAULT 'server',
    "httpStatus" INTEGER,
    "provider" TEXT,
    "modelId" TEXT,
    "retryable" BOOLEAN,
    "fingerprint" TEXT,
    "sentryEventId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TraceErrorEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TraceErrorEvidence_occurrenceId_key" ON "TraceErrorEvidence"("occurrenceId");
CREATE INDEX "TraceErrorEvidence_traceId_idx" ON "TraceErrorEvidence"("traceId");
CREATE INDEX "TraceErrorEvidence_release_occurredAt_idx" ON "TraceErrorEvidence"("release", "occurredAt");
CREATE INDEX "TraceErrorEvidence_errorCode_occurredAt_idx" ON "TraceErrorEvidence"("errorCode", "occurredAt");
CREATE INDEX "TraceErrorEvidence_occurredAt_idx" ON "TraceErrorEvidence"("occurredAt");

-- SetNull keeps the feedback row when its evidence ages out of retention.
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_traceEvidenceId_fkey"
    FOREIGN KEY ("traceEvidenceId") REFERENCES "TraceErrorEvidence"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
