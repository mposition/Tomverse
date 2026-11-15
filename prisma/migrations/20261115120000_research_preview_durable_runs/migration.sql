CREATE TABLE "ResearchPreviewRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sourceUserMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiModel" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "currentDate" TEXT NOT NULL,
    "questionDigest" TEXT NOT NULL,
    "pageReadingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totalOutputTokens" INTEGER NOT NULL,
    "inputTokenCeiling" INTEGER NOT NULL,
    "searchSurchargeCredits" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preparing',
    "stopReason" TEXT,
    "reservationId" TEXT,
    "checkpoint" JSONB,
    "checkpointVersion" INTEGER NOT NULL DEFAULT 0,
    "checkpointExpiresAt" TIMESTAMP(3),
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "searchCount" INTEGER NOT NULL DEFAULT 0,
    "readCount" INTEGER NOT NULL DEFAULT 0,
    "settlementUsage" JSONB,
    "cancelRequestedAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "activeDeadlineAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchPreviewRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ResearchPreviewRun_status_check" CHECK (
        "status" IN ('preparing', 'queued', 'running', 'checkpointed', 'completed', 'failed', 'cancelled', 'attention')
    ),
    CONSTRAINT "ResearchPreviewRun_stop_reason_check" CHECK (
        "stopReason" IS NULL OR "stopReason" IN (
            'report_submitted', 'invalid_report', 'unknown_source', 'missing_report',
            'budget_exhausted', 'usage_unknown', 'timeout', 'aborted',
            'provider_error', 'cancelled', 'outcome_unknown',
            'checkpoint_expired', 'dispatch_refused'
        )
    ),
    CONSTRAINT "ResearchPreviewRun_counts_check" CHECK (
        "stepCount" BETWEEN 0 AND 3 AND
        "searchCount" BETWEEN 0 AND 5 AND
        "readCount" BETWEEN 0 AND 2 AND
        "checkpointVersion" BETWEEN 0 AND 3 AND
        "leaseEpoch" >= 0
    ),
    CONSTRAINT "ResearchPreviewRun_token_ceiling_check" CHECK (
        "totalOutputTokens" BETWEEN 1 AND 4096 AND
        "inputTokenCeiling" > 0 AND
        "searchSurchargeCredits" >= 0
    ),
    CONSTRAINT "ResearchPreviewRun_question_digest_check" CHECK (
        "questionDigest" ~ '^sha256:[0-9a-f]{64}$'
    ),
    CONSTRAINT "ResearchPreviewRun_current_date_check" CHECK (
        "currentDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    ),
    CONSTRAINT "ResearchPreviewRun_checkpoint_size_check" CHECK (
        "checkpoint" IS NULL OR octet_length("checkpoint"::text) <= 524288
    ),
    CONSTRAINT "ResearchPreviewRun_checkpoint_expiry_check" CHECK (
        ("checkpoint" IS NULL AND "checkpointExpiresAt" IS NULL) OR
        ("checkpoint" IS NOT NULL AND "checkpointExpiresAt" IS NOT NULL)
    ),
    CONSTRAINT "ResearchPreviewRun_terminal_checkpoint_check" CHECK (
        "status" NOT IN ('completed', 'failed', 'cancelled', 'attention') OR
        ("checkpoint" IS NULL AND "checkpointExpiresAt" IS NULL)
    ),
    CONSTRAINT "ResearchPreviewRun_last_error_code_check" CHECK (
        "lastErrorCode" IS NULL OR char_length("lastErrorCode") BETWEEN 1 AND 80
    )
);

CREATE TABLE "ResearchPreviewGeneration" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "generationIndex" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'intent',
    "leaseEpoch" INTEGER NOT NULL,
    "checkpointVersionBefore" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "cacheWriteInputTokens" INTEGER,
    "outputTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "searchCount" INTEGER,
    "readCount" INTEGER,
    "stopReason" TEXT,
    "dispatchStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchPreviewGeneration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ResearchPreviewGeneration_status_check" CHECK (
        "status" IN ('intent', 'dispatch_started', 'completed', 'dispatch_refused', 'outcome_unknown')
    ),
    CONSTRAINT "ResearchPreviewGeneration_index_check" CHECK (
        "generationIndex" BETWEEN 1 AND 3 AND
        "checkpointVersionBefore" BETWEEN 0 AND 2 AND
        "leaseEpoch" >= 0
    ),
    CONSTRAINT "ResearchPreviewGeneration_usage_check" CHECK (
        ("inputTokens" IS NULL OR "inputTokens" >= 0) AND
        ("cachedInputTokens" IS NULL OR "cachedInputTokens" >= 0) AND
        ("cacheWriteInputTokens" IS NULL OR "cacheWriteInputTokens" >= 0) AND
        ("outputTokens" IS NULL OR "outputTokens" >= 0) AND
        ("reasoningTokens" IS NULL OR "reasoningTokens" >= 0) AND
        ("searchCount" IS NULL OR "searchCount" BETWEEN 0 AND 5) AND
        ("readCount" IS NULL OR "readCount" BETWEEN 0 AND 2)
    ),
    CONSTRAINT "ResearchPreviewGeneration_dispatch_time_check" CHECK (
        "status" IN ('intent', 'dispatch_refused') OR "dispatchStartedAt" IS NOT NULL
    ),
    CONSTRAINT "ResearchPreviewGeneration_completed_usage_check" CHECK (
        "status" <> 'completed' OR
        ("inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL AND "completedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "ResearchPreviewRun_assistantMessageId_key" ON "ResearchPreviewRun"("assistantMessageId");
CREATE UNIQUE INDEX "ResearchPreviewRun_reservationId_key" ON "ResearchPreviewRun"("reservationId");
CREATE INDEX "ResearchPreviewRun_userId_createdAt_idx" ON "ResearchPreviewRun"("userId", "createdAt");
CREATE INDEX "ResearchPreviewRun_conversationId_createdAt_idx" ON "ResearchPreviewRun"("conversationId", "createdAt");
CREATE INDEX "ResearchPreviewRun_status_leaseExpiresAt_createdAt_idx" ON "ResearchPreviewRun"("status", "leaseExpiresAt", "createdAt");
CREATE INDEX "ResearchPreviewRun_checkpointExpiresAt_idx" ON "ResearchPreviewRun"("checkpointExpiresAt");

CREATE UNIQUE INDEX "ResearchPreviewGeneration_runId_generationIndex_key" ON "ResearchPreviewGeneration"("runId", "generationIndex");
CREATE INDEX "ResearchPreviewGeneration_status_dispatchStartedAt_idx" ON "ResearchPreviewGeneration"("status", "dispatchStartedAt");

ALTER TABLE "Message" ADD COLUMN "researchRunId" TEXT;
CREATE UNIQUE INDEX "Message_researchRunId_key" ON "Message"("researchRunId");

ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_sourceUserMessageId_fkey"
    FOREIGN KEY ("sourceUserMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "ChatCreditReservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResearchPreviewGeneration" ADD CONSTRAINT "ResearchPreviewGeneration_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "ResearchPreviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_researchRunId_fkey"
    FOREIGN KEY ("researchRunId") REFERENCES "ResearchPreviewRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
