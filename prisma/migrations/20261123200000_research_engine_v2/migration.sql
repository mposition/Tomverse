-- Research engine v2: the expanded, owner-scoped Deep Research engine on top of
-- the existing durable Research Preview run and generation ledger.
--
-- Additive. Every existing row keeps engineVersion = 1 and every v1 bound is
-- kept for v1 rows: the constraints below only stop applying the Preview's
-- three-generation / five-search / two-read bounds to engineVersion = 2 rows,
-- whose work, money and evidence live in the new tables. Nothing is read or
-- rewritten; an active v1 run continues under its own decoder and price.

ALTER TABLE "ResearchPreviewRun"
  ADD COLUMN "engineVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "inputManifest" JSONB,
  ADD COLUMN "inputRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "planRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "approvedPlanRevision" INTEGER,
  ADD COLUMN "executionProfile" JSONB,
  ADD COLUMN "approvedCredits" INTEGER,
  ADD COLUMN "finalizationReserveCredits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pauseRequestedAt" TIMESTAMP(3),
  ADD COLUMN "pausedAt" TIMESTAMP(3),
  ADD COLUMN "runDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "qualityStatus" TEXT,
  ADD COLUMN "currentReportRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "eventSequence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recoveryFailureCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recoveryQuarantinedAt" TIMESTAMP(3);

ALTER TABLE "ResearchPreviewRun" DROP CONSTRAINT "ResearchPreviewRun_status_check";
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_status_check" CHECK (
  "status" IN ('preparing', 'queued', 'running', 'checkpointed', 'completed', 'failed', 'cancelled', 'attention',
    'draft', 'planning', 'awaiting_input', 'paused', 'finalizing')
);
ALTER TABLE "ResearchPreviewRun" DROP CONSTRAINT "ResearchPreviewRun_stop_reason_check";
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_stop_reason_check" CHECK (
  "stopReason" IS NULL OR "stopReason" IN (
    'report_submitted', 'invalid_report', 'unknown_source', 'missing_report',
    'budget_exhausted', 'usage_unknown', 'timeout', 'aborted',
    'provider_error', 'cancelled', 'outcome_unknown',
    'checkpoint_expired', 'dispatch_refused',
    'partial_report', 'run_deadline', 'source_revoked'
  )
);
ALTER TABLE "ResearchPreviewRun" DROP CONSTRAINT "ResearchPreviewRun_counts_check";
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_counts_check" CHECK (
  "leaseEpoch" >= 0 AND (
    ("engineVersion" = 1 AND
      "stepCount" BETWEEN 0 AND 3 AND
      "searchCount" BETWEEN 0 AND 5 AND
      "readCount" BETWEEN 0 AND 2 AND
      "checkpointVersion" BETWEEN 0 AND 3) OR
    ("engineVersion" = 2 AND
      "stepCount" >= 0 AND "searchCount" >= 0 AND "readCount" >= 0 AND
      "checkpointVersion" = 0)
  )
);
ALTER TABLE "ResearchPreviewRun" DROP CONSTRAINT "ResearchPreviewRun_token_ceiling_check";
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_token_ceiling_check" CHECK (
  "inputTokenCeiling" > 0 AND "searchSurchargeCredits" >= 0 AND (
    ("engineVersion" = 1 AND "totalOutputTokens" BETWEEN 1 AND 4096) OR
    ("engineVersion" = 2 AND "totalOutputTokens" >= 1)
  )
);
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_engine_version_check" CHECK (
  "engineVersion" IN (1, 2)
);
-- v2 never uses the run-level checkpoint or reservation: a v1 worker, expiry
-- sweep or recovery query that selects by them therefore never sees a v2 row.
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_v2_shape_check" CHECK (
  "engineVersion" = 1 OR (
    "checkpoint" IS NULL AND "reservationId" IS NULL AND
    "status" NOT IN ('preparing', 'checkpointed') AND
    "inputManifest" IS NOT NULL AND
    "approvedCredits" IS NOT NULL AND "approvedCredits" >= 0 AND
    "finalizationReserveCredits" >= 0 AND
    "finalizationReserveCredits" <= "approvedCredits" AND
    "inputRevision" >= 0 AND "planRevision" >= 0 AND
    "currentReportRevision" >= 0 AND "eventSequence" >= 0 AND
    octet_length("inputManifest"::text) <= 262144 AND
    ("executionProfile" IS NULL OR octet_length("executionProfile"::text) <= 16384)
  )
);
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_v1_shape_check" CHECK (
  "engineVersion" = 2 OR (
    "inputManifest" IS NULL AND "approvedCredits" IS NULL AND
    "status" NOT IN ('draft', 'planning', 'awaiting_input', 'paused', 'finalizing')
  )
);
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_quality_status_check" CHECK (
  "qualityStatus" IS NULL OR "qualityStatus" IN ('complete', 'partial', 'insufficient_evidence')
);
ALTER TABLE "ResearchPreviewRun" ADD CONSTRAINT "ResearchPreviewRun_recovery_failure_check" CHECK (
  "recoveryFailureCount" >= 0
);
CREATE INDEX "ResearchPreviewRun_engineVersion_status_createdAt_idx"
  ON "ResearchPreviewRun"("engineVersion", "status", "createdAt");

-- The generation ledger is reused for every v2 paid or external dispatch.
ALTER TABLE "ResearchPreviewGeneration"
  ADD COLUMN "engineVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'model',
  ADD COLUMN "workItemId" TEXT,
  ADD COLUMN "fundingSegmentId" TEXT,
  ADD COLUMN "modelId" TEXT,
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "apiModel" TEXT,
  ADD COLUMN "reasoning" TEXT,
  ADD COLUMN "pricingVersion" TEXT,
  ADD COLUMN "dispatchKey" TEXT,
  ADD COLUMN "searchRequestCount" INTEGER;

ALTER TABLE "ResearchPreviewGeneration" DROP CONSTRAINT "ResearchPreviewGeneration_index_check";
ALTER TABLE "ResearchPreviewGeneration" ADD CONSTRAINT "ResearchPreviewGeneration_index_check" CHECK (
  "leaseEpoch" >= 0 AND (
    ("engineVersion" = 1 AND
      "generationIndex" BETWEEN 1 AND 3 AND
      "checkpointVersionBefore" BETWEEN 0 AND 2) OR
    ("engineVersion" = 2 AND "generationIndex" >= 1 AND "checkpointVersionBefore" = 0)
  )
);
ALTER TABLE "ResearchPreviewGeneration" DROP CONSTRAINT "ResearchPreviewGeneration_usage_check";
ALTER TABLE "ResearchPreviewGeneration" ADD CONSTRAINT "ResearchPreviewGeneration_usage_check" CHECK (
  ("inputTokens" IS NULL OR "inputTokens" >= 0) AND
  ("cachedInputTokens" IS NULL OR "cachedInputTokens" >= 0) AND
  ("cacheWriteInputTokens" IS NULL OR "cacheWriteInputTokens" >= 0) AND
  ("outputTokens" IS NULL OR "outputTokens" >= 0) AND
  ("reasoningTokens" IS NULL OR "reasoningTokens" >= 0) AND
  ("searchRequestCount" IS NULL OR "searchRequestCount" >= 0) AND
  (("engineVersion" = 1 AND
     ("searchCount" IS NULL OR "searchCount" BETWEEN 0 AND 5) AND
     ("readCount" IS NULL OR "readCount" BETWEEN 0 AND 2)) OR
   ("engineVersion" = 2 AND
     ("searchCount" IS NULL OR "searchCount" >= 0) AND
     ("readCount" IS NULL OR "readCount" >= 0)))
);
-- A completed v2 search or read has no token usage; only a model dispatch must
-- carry provider usage to be "completed".
ALTER TABLE "ResearchPreviewGeneration" DROP CONSTRAINT "ResearchPreviewGeneration_completed_usage_check";
ALTER TABLE "ResearchPreviewGeneration" ADD CONSTRAINT "ResearchPreviewGeneration_completed_usage_check" CHECK (
  "status" <> 'completed' OR "completedAt" IS NOT NULL AND (
    "kind" <> 'model' OR ("inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL)
  )
);
ALTER TABLE "ResearchPreviewGeneration" ADD CONSTRAINT "ResearchPreviewGeneration_kind_check" CHECK (
  "kind" IN ('model', 'search', 'read')
);
ALTER TABLE "ResearchPreviewGeneration" ADD CONSTRAINT "ResearchPreviewGeneration_v2_shape_check" CHECK (
  "engineVersion" = 1 AND "kind" = 'model' AND "workItemId" IS NULL AND "dispatchKey" IS NULL OR
  "engineVersion" = 2 AND "workItemId" IS NOT NULL AND "dispatchKey" IS NOT NULL AND
    ("kind" <> 'model' OR ("fundingSegmentId" IS NOT NULL OR "status" = 'dispatch_refused') AND
      "modelId" IS NOT NULL AND "provider" IS NOT NULL AND "apiModel" IS NOT NULL AND "pricingVersion" IS NOT NULL)
);
CREATE UNIQUE INDEX "ResearchPreviewGeneration_runId_dispatchKey_key"
  ON "ResearchPreviewGeneration"("runId", "dispatchKey");
CREATE INDEX "ResearchPreviewGeneration_workItemId_idx" ON "ResearchPreviewGeneration"("workItemId");

CREATE TABLE "ResearchPlanRevision" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "author" TEXT NOT NULL,
  "inputRevision" INTEGER NOT NULL,
  "plan" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchPlanRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchPlanRevision_author_check" CHECK ("author" IN ('model', 'user')),
  CONSTRAINT "ResearchPlanRevision_revision_check" CHECK ("revision" >= 1 AND "inputRevision" >= 0),
  CONSTRAINT "ResearchPlanRevision_size_check" CHECK (octet_length("plan"::text) <= 131072)
);
CREATE UNIQUE INDEX "ResearchPlanRevision_runId_revision_key" ON "ResearchPlanRevision"("runId", "revision");

CREATE TABLE "ResearchWorkItem" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "planRevision" INTEGER NOT NULL,
  "inputRevision" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "priority" INTEGER NOT NULL DEFAULT 0,
  "payload" JSONB NOT NULL,
  "result" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "notBefore" TIMESTAMP(3),
  "leaseOwner" TEXT,
  "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
  "leaseExpiresAt" TIMESTAMP(3),
  "providerKey" TEXT,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchWorkItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchWorkItem_kind_check" CHECK ("kind" IN (
    'plan', 'investigate', 'search', 'read', 'analyze_private', 'coordinate',
    'verify', 'write_section', 'synthesize'
  )),
  CONSTRAINT "ResearchWorkItem_status_check" CHECK ("status" IN (
    'queued', 'running', 'completed', 'failed', 'cancelled', 'attention', 'superseded', 'blocked'
  )),
  CONSTRAINT "ResearchWorkItem_counts_check" CHECK (
    "attempts" >= 0 AND "leaseEpoch" >= 0 AND "planRevision" >= 0 AND "inputRevision" >= 0
  ),
  CONSTRAINT "ResearchWorkItem_lease_check" CHECK (
    ("status" = 'running') = ("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
  ),
  CONSTRAINT "ResearchWorkItem_size_check" CHECK (
    octet_length("payload"::text) <= 65536 AND ("result" IS NULL OR octet_length("result"::text) <= 131072)
  ),
  CONSTRAINT "ResearchWorkItem_error_code_check" CHECK (
    "errorCode" IS NULL OR char_length("errorCode") BETWEEN 1 AND 80
  )
);
CREATE UNIQUE INDEX "ResearchWorkItem_runId_idempotencyKey_key" ON "ResearchWorkItem"("runId", "idempotencyKey");
CREATE INDEX "ResearchWorkItem_status_notBefore_createdAt_idx" ON "ResearchWorkItem"("status", "notBefore", "createdAt");
CREATE INDEX "ResearchWorkItem_runId_status_idx" ON "ResearchWorkItem"("runId", "status");
CREATE INDEX "ResearchWorkItem_status_leaseExpiresAt_idx" ON "ResearchWorkItem"("status", "leaseExpiresAt");

CREATE TABLE "ResearchFundingSegment" (
  "id" TEXT NOT NULL,
  -- Nullable: a segment outlives its run (conversation, message or account deletion)
  -- so an unsettled or unknown hold keeps the facts expiry reconciliation needs.
  "runId" TEXT,
  "sequence" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'reserving',
  "reservationId" TEXT,
  "reservedCredits" INTEGER NOT NULL,
  "settledCredits" INTEGER,
  "modelId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "pricingVersion" TEXT NOT NULL,
  "searchSurchargeCredits" INTEGER NOT NULL DEFAULT 0,
  "settlementUsage" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchFundingSegment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchFundingSegment_purpose_check" CHECK ("purpose" IN ('plan', 'work', 'finalization')),
  CONSTRAINT "ResearchFundingSegment_status_check" CHECK ("status" IN (
    'reserving', 'reserved', 'settled', 'released', 'unknown'
  )),
  CONSTRAINT "ResearchFundingSegment_credits_check" CHECK (
    "sequence" >= 1 AND "reservedCredits" >= 0 AND "searchSurchargeCredits" >= 0 AND
    ("settledCredits" IS NULL OR ("settledCredits" >= 0 AND "settledCredits" <= "reservedCredits"))
  ),
  CONSTRAINT "ResearchFundingSegment_settled_check" CHECK (
    ("status" = 'settled') = ("settledCredits" IS NOT NULL AND "settledAt" IS NOT NULL)
  ),
  CONSTRAINT "ResearchFundingSegment_reservation_check" CHECK (
    "status" IN ('reserving', 'released') OR "reservationId" IS NOT NULL
  )
);
CREATE UNIQUE INDEX "ResearchFundingSegment_reservationId_key" ON "ResearchFundingSegment"("reservationId");
CREATE UNIQUE INDEX "ResearchFundingSegment_runId_sequence_key" ON "ResearchFundingSegment"("runId", "sequence");
CREATE INDEX "ResearchFundingSegment_status_createdAt_idx" ON "ResearchFundingSegment"("status", "createdAt");

CREATE TABLE "ResearchSource" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "visibility" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "canonicalUrl" TEXT,
  "title" TEXT,
  "publisher" TEXT,
  "snippet" TEXT,
  "publishedAt" TIMESTAMP(3),
  "ownerRef" JSONB,
  "duplicateOfSourceId" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchSource_origin_check" CHECK ("origin" IN (
    'web_search', 'user_url', 'discovered_link', 'attachment', 'conversation', 'memory', 'knowledge', 'project'
  )),
  CONSTRAINT "ResearchSource_visibility_check" CHECK ("visibility" IN ('public', 'private')),
  CONSTRAINT "ResearchSource_status_check" CHECK ("status" IN ('active', 'revoked', 'excluded')),
  -- A private source is never addressed by a URL; a public one always is.
  CONSTRAINT "ResearchSource_shape_check" CHECK (
    ("visibility" = 'public' AND "canonicalUrl" IS NOT NULL AND "ownerRef" IS NULL AND
      "origin" IN ('web_search', 'user_url', 'discovered_link')) OR
    ("visibility" = 'private' AND "canonicalUrl" IS NULL AND "ownerRef" IS NOT NULL AND
      "origin" IN ('attachment', 'conversation', 'memory', 'knowledge', 'project'))
  ),
  CONSTRAINT "ResearchSource_size_check" CHECK (
    char_length("sourceKey") BETWEEN 2 AND 16 AND
    ("canonicalUrl" IS NULL OR char_length("canonicalUrl") <= 2048) AND
    ("title" IS NULL OR char_length("title") <= 300) AND
    ("publisher" IS NULL OR char_length("publisher") <= 200) AND
    ("snippet" IS NULL OR char_length("snippet") <= 600)
  )
);
CREATE UNIQUE INDEX "ResearchSource_runId_sourceKey_key" ON "ResearchSource"("runId", "sourceKey");
CREATE INDEX "ResearchSource_runId_canonicalUrl_idx" ON "ResearchSource"("runId", "canonicalUrl");
CREATE INDEX "ResearchSource_runId_visibility_status_idx" ON "ResearchSource"("runId", "visibility", "status");

CREATE TABLE "ResearchSourceVersion" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "readStatus" TEXT NOT NULL,
  "extractionMethod" TEXT NOT NULL,
  "finalUrl" TEXT,
  "contentType" TEXT,
  "retrievedAt" TIMESTAMP(3) NOT NULL,
  "sourceModifiedAt" TIMESTAMP(3),
  "contentDigest" TEXT,
  "byteLength" INTEGER,
  "charLength" INTEGER,
  "truncated" BOOLEAN NOT NULL DEFAULT false,
  "failureReason" TEXT,
  "leadFingerprint" TEXT,
  "objectKey" TEXT,
  "chunkCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchSourceVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchSourceVersion_read_status_check" CHECK ("readStatus" IN ('snippet_only', 'read', 'unavailable')),
  CONSTRAINT "ResearchSourceVersion_method_check" CHECK ("extractionMethod" IN (
    'search_snippet', 'html_text', 'plain_text', 'pdf_text', 'office_text', 'sheet_rows', 'csv_rows',
    'conversation_messages', 'memory_item', 'knowledge_chunks', 'project_material', 'none'
  )),
  -- Snippets are never stored as read evidence and an unread version holds no body.
  CONSTRAINT "ResearchSourceVersion_shape_check" CHECK (
    ("readStatus" = 'read' AND "objectKey" IS NOT NULL AND "contentDigest" ~ '^sha256:[0-9a-f]{64}$' AND
      "failureReason" IS NULL) OR
    ("readStatus" = 'snippet_only' AND "extractionMethod" = 'search_snippet' AND "objectKey" IS NULL AND
      "chunkCount" = 0 AND "truncated" = false) OR
    ("readStatus" = 'unavailable' AND "objectKey" IS NULL AND "chunkCount" = 0 AND "failureReason" IS NOT NULL)
  ),
  CONSTRAINT "ResearchSourceVersion_counts_check" CHECK (
    "version" >= 1 AND "chunkCount" >= 0 AND
    ("byteLength" IS NULL OR "byteLength" >= 0) AND ("charLength" IS NULL OR "charLength" >= 0)
  )
);
CREATE UNIQUE INDEX "ResearchSourceVersion_objectKey_key" ON "ResearchSourceVersion"("objectKey");
CREATE UNIQUE INDEX "ResearchSourceVersion_sourceId_version_key" ON "ResearchSourceVersion"("sourceId", "version");
CREATE INDEX "ResearchSourceVersion_runId_idx" ON "ResearchSourceVersion"("runId");

CREATE TABLE "ResearchEvidenceChunk" (
  "id" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "locator" JSONB NOT NULL,
  "charStart" INTEGER NOT NULL,
  "charEnd" INTEGER NOT NULL,
  "digest" TEXT NOT NULL,
  CONSTRAINT "ResearchEvidenceChunk_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchEvidenceChunk_range_check" CHECK (
    "chunkIndex" >= 0 AND "charStart" >= 0 AND "charEnd" > "charStart" AND
    "digest" ~ '^sha256:[0-9a-f]{64}$' AND octet_length("locator"::text) <= 2048
  )
);
CREATE UNIQUE INDEX "ResearchEvidenceChunk_versionId_chunkIndex_key" ON "ResearchEvidenceChunk"("versionId", "chunkIndex");
CREATE INDEX "ResearchEvidenceChunk_runId_idx" ON "ResearchEvidenceChunk"("runId");

CREATE TABLE "ResearchReportRevision" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "parentRevision" INTEGER,
  "planRevision" INTEGER NOT NULL,
  "inputRevision" INTEGER NOT NULL,
  "author" TEXT NOT NULL,
  "qualityStatus" TEXT NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'owner',
  "containsPrivate" BOOLEAN NOT NULL DEFAULT false,
  "document" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchReportRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchReportRevision_author_check" CHECK ("author" IN ('model', 'user_edit', 'follow_up', 'redaction')),
  CONSTRAINT "ResearchReportRevision_quality_check" CHECK ("qualityStatus" IN ('complete', 'partial', 'insufficient_evidence')),
  CONSTRAINT "ResearchReportRevision_visibility_check" CHECK ("visibility" IN ('owner', 'public')),
  -- A public projection can never carry private-derived content.
  CONSTRAINT "ResearchReportRevision_public_check" CHECK ("visibility" = 'owner' OR "containsPrivate" = false),
  CONSTRAINT "ResearchReportRevision_revision_check" CHECK (
    "revision" >= 1 AND ("parentRevision" IS NULL OR ("parentRevision" >= 1 AND "parentRevision" < "revision"))
  ),
  CONSTRAINT "ResearchReportRevision_size_check" CHECK (octet_length("document"::text) <= 2097152)
);
CREATE UNIQUE INDEX "ResearchReportRevision_runId_revision_key" ON "ResearchReportRevision"("runId", "revision");

CREATE TABLE "ResearchClaim" (
  "id" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "claimKey" TEXT NOT NULL,
  "sectionKey" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "verification" TEXT NOT NULL,
  "privateDerived" BOOLEAN NOT NULL DEFAULT false,
  "evidence" JSONB NOT NULL,
  "checks" JSONB,
  CONSTRAINT "ResearchClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchClaim_kind_check" CHECK ("kind" IN ('fact', 'inference', 'uncertain')),
  CONSTRAINT "ResearchClaim_verification_check" CHECK ("verification" IN (
    'supported', 'partial', 'conflicting', 'unverified', 'unsupported'
  )),
  CONSTRAINT "ResearchClaim_size_check" CHECK (
    char_length("text") BETWEEN 1 AND 2000 AND octet_length("evidence"::text) <= 32768
  )
);
CREATE UNIQUE INDEX "ResearchClaim_revisionId_claimKey_key" ON "ResearchClaim"("revisionId", "claimKey");
CREATE INDEX "ResearchClaim_runId_idx" ON "ResearchClaim"("runId");

CREATE TABLE "ResearchEvidenceObjectCleanup" (
  "id" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchEvidenceObjectCleanup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchEvidenceObjectCleanup_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "ResearchEvidenceObjectCleanup_reason_check" CHECK ("reason" IN (
    'run_deleted', 'conversation_deleted', 'account_deleted', 'source_revoked', 'superseded', 'write_pending'
  )),
  CONSTRAINT "ResearchEvidenceObjectCleanup_key_check" CHECK ("objectKey" LIKE 'research-evidence/%')
);
CREATE UNIQUE INDEX "ResearchEvidenceObjectCleanup_objectKey_key" ON "ResearchEvidenceObjectCleanup"("objectKey");
CREATE INDEX "ResearchEvidenceObjectCleanup_nextAttemptAt_idx" ON "ResearchEvidenceObjectCleanup"("nextAttemptAt");

ALTER TABLE "ResearchPreviewGeneration" ADD CONSTRAINT "ResearchPreviewGeneration_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "ResearchWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchPreviewGeneration" ADD CONSTRAINT "ResearchPreviewGeneration_fundingSegmentId_fkey"
  FOREIGN KEY ("fundingSegmentId") REFERENCES "ResearchFundingSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResearchPlanRevision" ADD CONSTRAINT "ResearchPlanRevision_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ResearchPreviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchWorkItem" ADD CONSTRAINT "ResearchWorkItem_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ResearchPreviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchFundingSegment" ADD CONSTRAINT "ResearchFundingSegment_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ResearchPreviewRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResearchFundingSegment" ADD CONSTRAINT "ResearchFundingSegment_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "ChatCreditReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ResearchPreviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchSourceVersion" ADD CONSTRAINT "ResearchSourceVersion_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "ResearchSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchEvidenceChunk" ADD CONSTRAINT "ResearchEvidenceChunk_versionId_fkey"
  FOREIGN KEY ("versionId") REFERENCES "ResearchSourceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchReportRevision" ADD CONSTRAINT "ResearchReportRevision_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ResearchPreviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_revisionId_fkey"
  FOREIGN KEY ("revisionId") REFERENCES "ResearchReportRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deleting a run, its conversation or its account removes the evidence rows by
-- cascade. The private objects they name are queued for deletion in the same
-- statement so a cascade can never orphan an object in storage.
CREATE FUNCTION research_evidence_object_cleanup() RETURNS trigger AS $$
BEGIN
  IF OLD."objectKey" IS NOT NULL THEN
    INSERT INTO "ResearchEvidenceObjectCleanup" ("id", "objectKey", "reason")
    VALUES (md5(random()::text || clock_timestamp()::text), OLD."objectKey", 'run_deleted')
    ON CONFLICT ("objectKey") DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ResearchSourceVersion_object_cleanup"
  AFTER DELETE ON "ResearchSourceVersion"
  FOR EACH ROW EXECUTE FUNCTION research_evidence_object_cleanup();
