-- AMUX v4 idea intake storage, phase A. Schema only: no writer, worker, flag,
-- scheduled deletion, model call, or promotion is activated by this migration.
-- Existing AMUX cards, source revisions, grants, status, and audit rows are
-- untouched. Sensitive columns are nullable so no unapproved retention
-- deadline is silently selected for an undecided expired draft.
-- *Digest is keyed HMAC-SHA256 over canonical data, never a plain text hash;
-- *DigestKeyId names the server-held verification key. SQL checks the pair,
-- while writer tests must prove the algorithm and key rotation.

BEGIN;

CREATE TABLE "AmuxIdeaSubmission" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "rawCiphertext" BYTEA,
    "rawKeyId" TEXT,
    "rawKeyVersion" INTEGER,
    "rawDigest" TEXT,
    "rawDigestKeyId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "analysisDeadlineAt" TIMESTAMP(3) NOT NULL,
    "analysisCompletedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "rawPurgeAfter" TIMESTAMP(3),
    "rawPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxIdeaSubmission_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIdeaSubmission_state_check" CHECK (
        "state" IN ('submitted', 'collecting', 'awaiting_preview', 'analyzing', 'awaiting_owner', 'completed', 'cancelled')
    ),
    CONSTRAINT "AmuxIdeaSubmission_analysis_deadline_check" CHECK (
        "analysisDeadlineAt" = "submittedAt" + INTERVAL '7 days'
    ),
    CONSTRAINT "AmuxIdeaSubmission_raw_key_pair_check" CHECK (
        ("rawCiphertext" IS NULL AND "rawKeyId" IS NULL AND "rawKeyVersion" IS NULL) OR
        ("rawCiphertext" IS NOT NULL AND "rawKeyId" IS NOT NULL AND length("rawKeyId") > 0 AND "rawKeyVersion" IS NOT NULL AND "rawKeyVersion" > 0)
    ),
    CONSTRAINT "AmuxIdeaSubmission_raw_digest_check" CHECK (
        ("rawDigest" IS NULL AND "rawDigestKeyId" IS NULL) OR
        ("rawDigest" IS NOT NULL AND "rawDigest" ~ '^[a-f0-9]{64}$' AND "rawDigestKeyId" IS NOT NULL AND length("rawDigestKeyId") > 0)
    ),
    CONSTRAINT "AmuxIdeaSubmission_raw_purged_check" CHECK (
        "rawPurgedAt" IS NULL OR ("rawCiphertext" IS NULL AND "rawKeyId" IS NULL AND "rawKeyVersion" IS NULL)
    ),
    CONSTRAINT "AmuxIdeaSubmission_terminal_time_check" CHECK (
        "analysisCompletedAt" IS NULL OR "cancelledAt" IS NULL OR "cancelledAt" >= "analysisCompletedAt"
    ),
    CONSTRAINT "AmuxIdeaSubmission_state_time_check" CHECK (
        ("state" NOT IN ('awaiting_owner', 'completed') OR "analysisCompletedAt" IS NOT NULL) AND
        ("state" <> 'cancelled' OR "cancelledAt" IS NOT NULL) AND
        ("cancelledAt" IS NULL OR "state" = 'cancelled') AND
        ("analysisCompletedAt" IS NULL OR "state" IN ('awaiting_owner', 'completed', 'cancelled'))
    )
);

CREATE INDEX "AmuxIdeaSubmission_state_analysisDeadlineAt_idx"
    ON "AmuxIdeaSubmission"("state", "analysisDeadlineAt");
CREATE UNIQUE INDEX "AmuxIdeaSubmission_id_actorUserId_key"
    ON "AmuxIdeaSubmission"("id", "actorUserId");
CREATE INDEX "AmuxIdeaSubmission_rawPurgeAfter_rawPurgedAt_idx"
    ON "AmuxIdeaSubmission"("rawPurgeAfter", "rawPurgedAt");
CREATE INDEX "AmuxIdeaSubmission_actorUserId_submittedAt_idx"
    ON "AmuxIdeaSubmission"("actorUserId", "submittedAt");

CREATE TABLE "AmuxIdeaSourceScopeApproval" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scopeCiphertext" BYTEA,
    "scopeKeyId" TEXT,
    "scopeKeyVersion" INTEGER,
    "scopeDigest" TEXT NOT NULL,
    "scopeDigestKeyId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "scopePurgeAfter" TIMESTAMP(3),
    "scopePurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxIdeaSourceScopeApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIdeaSourceScopeApproval_status_check" CHECK (
        "status" IN ('approved', 'consumed', 'expired', 'revoked', 'outcome_unknown')
    ),
    CONSTRAINT "AmuxIdeaSourceScopeApproval_digest_check" CHECK (
        "scopeDigest" ~ '^[a-f0-9]{64}$' AND "scopeDigestKeyId" IS NOT NULL AND length("scopeDigestKeyId") > 0
    ),
    CONSTRAINT "AmuxIdeaSourceScopeApproval_key_pair_check" CHECK (
        ("scopeCiphertext" IS NULL AND "scopeKeyId" IS NULL AND "scopeKeyVersion" IS NULL) OR
        ("scopeCiphertext" IS NOT NULL AND "scopeKeyId" IS NOT NULL AND length("scopeKeyId") > 0 AND "scopeKeyVersion" IS NOT NULL AND "scopeKeyVersion" > 0)
    ),
    CONSTRAINT "AmuxIdeaSourceScopeApproval_purged_check" CHECK (
        "scopePurgedAt" IS NULL OR ("scopeCiphertext" IS NULL AND "scopeKeyId" IS NULL AND "scopeKeyVersion" IS NULL)
    ),
    CONSTRAINT "AmuxIdeaSourceScopeApproval_expiry_check" CHECK ("expiresAt" > "approvedAt"),
    CONSTRAINT "AmuxIdeaSourceScopeApproval_consumed_check" CHECK (
        ("status" <> 'consumed' OR "consumedAt" IS NOT NULL) AND
        ("consumedAt" IS NULL OR ("consumedAt" >= "approvedAt" AND "consumedAt" <= "expiresAt")) AND
        ("status" <> 'revoked' OR "revokedAt" IS NOT NULL) AND
        ("revokedAt" IS NULL OR "status" = 'revoked')
    )
);

CREATE UNIQUE INDEX "AmuxIdeaSourceScopeApproval_id_ideaId_key"
    ON "AmuxIdeaSourceScopeApproval"("id", "ideaId");
CREATE UNIQUE INDEX "AmuxIdeaSourceScopeApproval_authorizationAuditLogId_key"
    ON "AmuxIdeaSourceScopeApproval"("authorizationAuditLogId");
CREATE INDEX "AmuxIdeaSourceScopeApproval_ideaId_status_expiresAt_idx"
    ON "AmuxIdeaSourceScopeApproval"("ideaId", "status", "expiresAt");
CREATE INDEX "AmuxIdeaSourceScopeApproval_scopePurgeAfter_scopePurgedAt_idx"
    ON "AmuxIdeaSourceScopeApproval"("scopePurgeAfter", "scopePurgedAt");

ALTER TABLE "AmuxIdeaSourceScopeApproval"
    ADD CONSTRAINT "AmuxIdeaSourceScopeApproval_ideaId_actorUserId_fkey"
    FOREIGN KEY ("ideaId", "actorUserId") REFERENCES "AmuxIdeaSubmission"("id", "actorUserId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "AmuxIdeaTransferPreview" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "sourceScopeApprovalId" TEXT,
    "chunkIndex" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "payloadCiphertext" BYTEA,
    "payloadKeyId" TEXT,
    "payloadKeyVersion" INTEGER,
    "payloadDigest" TEXT NOT NULL,
    "payloadDigestKeyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmExpiresAt" TIMESTAMP(3),
    "confirmedByUserId" TEXT,
    "confirmationAuditLogId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "outcomeUnknownAt" TIMESTAMP(3),
    "payloadPurgeAfter" TIMESTAMP(3),
    "payloadPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxIdeaTransferPreview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIdeaTransferPreview_state_check" CHECK (
        "state" IN ('prepared', 'confirmed', 'in_flight', 'completed', 'owner_rejected', 'provider_failed', 'expired', 'outcome_unknown')
    ),
    CONSTRAINT "AmuxIdeaTransferPreview_position_check" CHECK (
        "chunkIndex" >= 0 AND "attempt" >= 1
    ),
    CONSTRAINT "AmuxIdeaTransferPreview_digest_check" CHECK (
        "payloadDigest" ~ '^[a-f0-9]{64}$' AND "payloadDigestKeyId" IS NOT NULL AND length("payloadDigestKeyId") > 0
    ),
    CONSTRAINT "AmuxIdeaTransferPreview_key_pair_check" CHECK (
        ("payloadCiphertext" IS NULL AND "payloadKeyId" IS NULL AND "payloadKeyVersion" IS NULL) OR
        ("payloadCiphertext" IS NOT NULL AND "payloadKeyId" IS NOT NULL AND length("payloadKeyId") > 0 AND "payloadKeyVersion" IS NOT NULL AND "payloadKeyVersion" > 0)
    ),
    CONSTRAINT "AmuxIdeaTransferPreview_purged_check" CHECK (
        "payloadPurgedAt" IS NULL OR ("payloadCiphertext" IS NULL AND "payloadKeyId" IS NULL AND "payloadKeyVersion" IS NULL)
    ),
    CONSTRAINT "AmuxIdeaTransferPreview_confirm_check" CHECK (
        ("confirmedAt" IS NULL AND "confirmExpiresAt" IS NULL AND "confirmedByUserId" IS NULL AND "confirmationAuditLogId" IS NULL) OR
        ("confirmedAt" IS NOT NULL AND "confirmExpiresAt" IS NOT NULL AND "confirmedByUserId" IS NOT NULL AND "confirmationAuditLogId" IS NOT NULL AND "confirmExpiresAt" > "confirmedAt" AND "confirmExpiresAt" <= "expiresAt")
    ),
    CONSTRAINT "AmuxIdeaTransferPreview_state_confirm_check" CHECK (
        "state" NOT IN ('confirmed', 'in_flight', 'completed', 'provider_failed', 'outcome_unknown') OR "confirmedAt" IS NOT NULL
    ),
    CONSTRAINT "AmuxIdeaTransferPreview_consumed_check" CHECK (
        "consumedAt" IS NULL OR ("confirmedAt" IS NOT NULL AND "consumedAt" >= "confirmedAt" AND "consumedAt" <= "confirmExpiresAt")
    ),
    CONSTRAINT "AmuxIdeaTransferPreview_prepared_check" CHECK (
        "state" <> 'prepared' OR "confirmedAt" IS NULL
    ),
    CONSTRAINT "AmuxIdeaTransferPreview_unknown_check" CHECK (
        "state" <> 'outcome_unknown' OR "outcomeUnknownAt" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "AmuxIdeaTransferPreview_ideaId_chunkIndex_attempt_key"
    ON "AmuxIdeaTransferPreview"("ideaId", "chunkIndex", "attempt");
CREATE UNIQUE INDEX "AmuxIdeaTransferPreview_id_ideaId_chunkIndex_key"
    ON "AmuxIdeaTransferPreview"("id", "ideaId", "chunkIndex");
CREATE UNIQUE INDEX "AmuxIdeaTransferPreview_confirmationAuditLogId_key"
    ON "AmuxIdeaTransferPreview"("confirmationAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaTransferPreview_one_active_per_chunk"
    ON "AmuxIdeaTransferPreview"("ideaId", "chunkIndex")
    WHERE "state" IN ('confirmed', 'in_flight', 'outcome_unknown');
CREATE INDEX "AmuxIdeaTransferPreview_state_expiresAt_idx"
    ON "AmuxIdeaTransferPreview"("state", "expiresAt");
CREATE INDEX "AmuxIdeaTransferPreview_sourceScopeApprovalId_idx"
    ON "AmuxIdeaTransferPreview"("sourceScopeApprovalId");
CREATE INDEX "AmuxIdeaTransferPreview_payloadPurgeAfter_payloadPurgedAt_idx"
    ON "AmuxIdeaTransferPreview"("payloadPurgeAfter", "payloadPurgedAt");

ALTER TABLE "AmuxIdeaTransferPreview"
    ADD CONSTRAINT "AmuxIdeaTransferPreview_ideaId_fkey"
    FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaTransferPreview_sourceScopeApprovalId_ideaId_fkey"
    FOREIGN KEY ("sourceScopeApprovalId", "ideaId")
    REFERENCES "AmuxIdeaSourceScopeApproval"("id", "ideaId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaTransferPreview_ideaId_confirmedByUserId_fkey"
    FOREIGN KEY ("ideaId", "confirmedByUserId")
    REFERENCES "AmuxIdeaSubmission"("id", "actorUserId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "AmuxIdeaAnalysisChunk" (
    "ideaId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "leaseGeneration" INTEGER NOT NULL,
    "currentPreviewId" TEXT,
    "draftVersion" INTEGER,
    "draftCiphertext" BYTEA,
    "draftKeyId" TEXT,
    "draftKeyVersion" INTEGER,
    "draftDigest" TEXT,
    "draftDigestKeyId" TEXT,
    "freeformCiphertext" BYTEA,
    "freeformKeyId" TEXT,
    "freeformKeyVersion" INTEGER,
    "coveredStartOrdinal" INTEGER,
    "coveredEndOrdinal" INTEGER,
    "remainingStartOrdinal" INTEGER,
    "remainingEndOrdinal" INTEGER,
    "analysisCompletedAt" TIMESTAMP(3),
    "finalDecisionAt" TIMESTAMP(3),
    "bodyPurgeAfter" TIMESTAMP(3),
    "bodyPurgedAt" TIMESTAMP(3),
    "freeformPurgeAfter" TIMESTAMP(3),
    "freeformPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxIdeaAnalysisChunk_pkey" PRIMARY KEY ("ideaId", "chunkIndex"),
    CONSTRAINT "AmuxIdeaAnalysisChunk_state_check" CHECK (
        "state" IN ('pending', 'collecting', 'awaiting_preview', 'in_flight', 'draft_ready', 'partially_decided', 'decided', 'expired', 'cancelled', 'outcome_unknown')
    ),
    CONSTRAINT "AmuxIdeaAnalysisChunk_position_check" CHECK (
        "chunkIndex" >= 0 AND "attempt" >= 0 AND "leaseGeneration" >= 0
    ),
    CONSTRAINT "AmuxIdeaAnalysisChunk_draft_pair_check" CHECK (
        ("draftCiphertext" IS NULL AND "draftKeyId" IS NULL AND "draftKeyVersion" IS NULL) OR
        ("draftCiphertext" IS NOT NULL AND "draftKeyId" IS NOT NULL AND length("draftKeyId") > 0 AND "draftKeyVersion" IS NOT NULL AND "draftKeyVersion" > 0)
    ),
    CONSTRAINT "AmuxIdeaAnalysisChunk_freeform_pair_check" CHECK (
        ("freeformCiphertext" IS NULL AND "freeformKeyId" IS NULL AND "freeformKeyVersion" IS NULL) OR
        ("freeformCiphertext" IS NOT NULL AND "freeformKeyId" IS NOT NULL AND length("freeformKeyId") > 0 AND "freeformKeyVersion" IS NOT NULL AND "freeformKeyVersion" > 0)
    ),
    CONSTRAINT "AmuxIdeaAnalysisChunk_draft_digest_check" CHECK (
        ("draftDigest" IS NULL AND "draftDigestKeyId" IS NULL) OR
        ("draftDigest" IS NOT NULL AND "draftDigest" ~ '^[a-f0-9]{64}$' AND "draftDigestKeyId" IS NOT NULL AND length("draftDigestKeyId") > 0)
    ),
    CONSTRAINT "AmuxIdeaAnalysisChunk_draft_version_check" CHECK (
        "draftVersion" IS NULL OR "draftVersion" > 0
    ),
    CONSTRAINT "AmuxIdeaAnalysisChunk_covered_ordinals_check" CHECK (
        ("coveredStartOrdinal" IS NULL AND "coveredEndOrdinal" IS NULL) OR
        ("coveredStartOrdinal" IS NOT NULL AND "coveredEndOrdinal" IS NOT NULL AND
         "coveredStartOrdinal" >= 0 AND "coveredEndOrdinal" >= "coveredStartOrdinal")
    ),
    CONSTRAINT "AmuxIdeaAnalysisChunk_remaining_ordinals_check" CHECK (
        ("remainingStartOrdinal" IS NULL AND "remainingEndOrdinal" IS NULL) OR
        ("remainingStartOrdinal" IS NOT NULL AND "remainingEndOrdinal" IS NOT NULL AND
         "remainingStartOrdinal" >= 0 AND "remainingEndOrdinal" >= "remainingStartOrdinal")
    ),
    CONSTRAINT "AmuxIdeaAnalysisChunk_purged_check" CHECK (
        ("bodyPurgedAt" IS NULL OR ("draftCiphertext" IS NULL AND "draftKeyId" IS NULL AND "draftKeyVersion" IS NULL)) AND
        ("freeformPurgedAt" IS NULL OR ("freeformCiphertext" IS NULL AND "freeformKeyId" IS NULL AND "freeformKeyVersion" IS NULL))
    ),
    CONSTRAINT "AmuxIdeaAnalysisChunk_state_time_check" CHECK (
        "state" NOT IN ('draft_ready', 'partially_decided', 'decided', 'expired') OR "analysisCompletedAt" IS NOT NULL
    ),
    CONSTRAINT "AmuxIdeaAnalysisChunk_decision_time_check" CHECK (
        "state" <> 'decided' OR "finalDecisionAt" IS NOT NULL
    ),
    CONSTRAINT "AmuxIdeaAnalysisChunk_in_flight_preview_check" CHECK (
        "state" <> 'in_flight' OR "currentPreviewId" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "AmuxIdeaAnalysisChunk_currentPreviewId_key"
    ON "AmuxIdeaAnalysisChunk"("currentPreviewId");
CREATE UNIQUE INDEX "AmuxIdeaAnalysisChunk_currentPreviewId_ideaId_chunkIndex_key"
    ON "AmuxIdeaAnalysisChunk"("currentPreviewId", "ideaId", "chunkIndex");
CREATE INDEX "AmuxIdeaAnalysisChunk_state_analysisCompletedAt_idx"
    ON "AmuxIdeaAnalysisChunk"("state", "analysisCompletedAt");
CREATE INDEX "AmuxIdeaAnalysisChunk_bodyPurgeAfter_bodyPurgedAt_idx"
    ON "AmuxIdeaAnalysisChunk"("bodyPurgeAfter", "bodyPurgedAt");
CREATE INDEX "AmuxIdeaAnalysisChunk_freeformPurgeAfter_freeformPurgedAt_idx"
    ON "AmuxIdeaAnalysisChunk"("freeformPurgeAfter", "freeformPurgedAt");

ALTER TABLE "AmuxIdeaAnalysisChunk"
    ADD CONSTRAINT "AmuxIdeaAnalysisChunk_ideaId_actorUserId_fkey"
    FOREIGN KEY ("ideaId", "actorUserId") REFERENCES "AmuxIdeaSubmission"("id", "actorUserId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaAnalysisChunk_currentPreviewId_ideaId_chunkIndex_fkey"
    FOREIGN KEY ("currentPreviewId", "ideaId", "chunkIndex")
    REFERENCES "AmuxIdeaTransferPreview"("id", "ideaId", "chunkIndex")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AmuxIdeaTransferPreview"
    ADD CONSTRAINT "AmuxIdeaTransferPreview_ideaId_chunkIndex_fkey"
    FOREIGN KEY ("ideaId", "chunkIndex")
    REFERENCES "AmuxIdeaAnalysisChunk"("ideaId", "chunkIndex")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
