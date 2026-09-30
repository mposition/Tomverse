-- Authenticated Tomverse Chat durable composer and response-attempt state.
-- Additive only: no existing row is rewritten and no provider execution path
-- is wired by this migration.

CREATE TABLE "ChatComposerDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "conversationId" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "attachmentReferences" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatComposerDraft_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ChatComposerDraft_revision_check"
      CHECK ("revision" >= 1),
    CONSTRAINT "ChatComposerDraft_scope_check"
      CHECK (
        ("scopeKey" = 'new' AND "conversationId" IS NULL) OR
        ("conversationId" IS NOT NULL AND "scopeKey" = "conversationId")
      ),
    CONSTRAINT "ChatComposerDraft_scope_length_check"
      CHECK (char_length("scopeKey") BETWEEN 1 AND 64),
    CONSTRAINT "ChatComposerDraft_text_length_check"
      CHECK (char_length("text") <= 50000),
    CONSTRAINT "ChatComposerDraft_attachment_references_check"
      CHECK (
        jsonb_typeof("attachmentReferences") = 'array' AND
        jsonb_array_length("attachmentReferences") <= 5
      )
);

CREATE UNIQUE INDEX "ChatComposerDraft_userId_scopeKey_key"
  ON "ChatComposerDraft"("userId", "scopeKey");
CREATE INDEX "ChatComposerDraft_conversationId_idx"
  ON "ChatComposerDraft"("conversationId");

ALTER TABLE "ChatComposerDraft"
  ADD CONSTRAINT "ChatComposerDraft_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatComposerDraft"
  ADD CONSTRAINT "ChatComposerDraft_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ChatResponseAttempt" (
    "assistantMessageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sourceUserMessageId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "requestedModelId" TEXT NOT NULL,
    "actualModelId" TEXT,
    "provider" TEXT,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "partialContent" TEXT NOT NULL DEFAULT '',
    "checkpointRevision" INTEGER NOT NULL DEFAULT 0,
    "ownerId" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "finishReason" TEXT,
    "failureCode" TEXT,
    "terminalAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatResponseAttempt_pkey" PRIMARY KEY ("assistantMessageId"),
    CONSTRAINT "ChatResponseAttempt_status_check"
      CHECK ("status" IN ('claimed', 'streaming', 'completed', 'failed', 'cancelled')),
    CONSTRAINT "ChatResponseAttempt_finish_reason_check"
      CHECK (
        "finishReason" IS NULL OR
        "finishReason" IN ('stop', 'length', 'content_filter', 'tool_call', 'cancelled', 'error')
      ),
    CONSTRAINT "ChatResponseAttempt_failure_code_check"
      CHECK (
        "failureCode" IS NULL OR
        "failureCode" IN (
          'provider_unavailable',
          'model_unavailable',
          'request_refused',
          'stream_interrupted',
          'worker_lease_expired',
          'internal_error'
        )
      ),
    CONSTRAINT "ChatResponseAttempt_revision_check"
      CHECK ("checkpointRevision" >= 0),
    CONSTRAINT "ChatResponseAttempt_lease_bound_check"
      CHECK (
        "status" = 'completed' OR "status" = 'failed' OR "status" = 'cancelled' OR
        (
          "leaseExpiresAt" > "updatedAt" AND
          "leaseExpiresAt" <= "updatedAt" + INTERVAL '5 minutes'
        )
      ),
    CONSTRAINT "ChatResponseAttempt_fingerprint_check"
      CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ChatResponseAttempt_identity_length_check"
      CHECK (
        char_length("assistantMessageId") BETWEEN 1 AND 64 AND
        char_length("sourceUserMessageId") BETWEEN 1 AND 64 AND
        char_length("requestedModelId") BETWEEN 1 AND 120 AND
        char_length("ownerId") BETWEEN 1 AND 128
      ),
    CONSTRAINT "ChatResponseAttempt_partial_length_check"
      CHECK (char_length("partialContent") <= 2000000),
    CONSTRAINT "ChatResponseAttempt_terminal_check"
      CHECK (
        ("status" IN ('completed', 'failed', 'cancelled') AND "terminalAt" IS NOT NULL) OR
        ("status" IN ('claimed', 'streaming') AND "terminalAt" IS NULL)
      ),
    CONSTRAINT "ChatResponseAttempt_terminal_metadata_check"
      CHECK (
        ("status" = 'failed' AND "finishReason" = 'error' AND "failureCode" IS NOT NULL) OR
        ("status" = 'cancelled' AND "finishReason" = 'cancelled' AND "failureCode" IS NULL) OR
        (
          "status" = 'completed' AND
          ("finishReason" IS NULL OR "finishReason" IN ('stop', 'length', 'content_filter', 'tool_call')) AND
          "failureCode" IS NULL
        ) OR
        ("status" IN ('claimed', 'streaming') AND "finishReason" IS NULL AND "failureCode" IS NULL)
      )
);

CREATE INDEX "ChatResponseAttempt_userId_updatedAt_idx"
  ON "ChatResponseAttempt"("userId", "updatedAt");
CREATE INDEX "ChatResponseAttempt_conversationId_updatedAt_idx"
  ON "ChatResponseAttempt"("conversationId", "updatedAt");
CREATE INDEX "ChatResponseAttempt_status_leaseExpiresAt_idx"
  ON "ChatResponseAttempt"("status", "leaseExpiresAt");
CREATE INDEX "ChatResponseAttempt_sourceUserMessageId_idx"
  ON "ChatResponseAttempt"("sourceUserMessageId");

ALTER TABLE "ChatResponseAttempt"
  ADD CONSTRAINT "ChatResponseAttempt_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatResponseAttempt"
  ADD CONSTRAINT "ChatResponseAttempt_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatResponseAttempt"
  ADD CONSTRAINT "ChatResponseAttempt_sourceUserMessageId_fkey"
  FOREIGN KEY ("sourceUserMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
