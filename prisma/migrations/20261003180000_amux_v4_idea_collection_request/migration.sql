-- Dark AMUX v4 one-source collection request. No writer, dispatch, model call,
-- GitHub read, or production switch is enabled by this additive migration.
-- Request and result digests are keyed HMAC-SHA256; no idea or source body is
-- stored outside bounded encrypted resultCiphertext.

CREATE UNIQUE INDEX "AmuxIdeaFrontierModelApproval_binding_key"
    ON "AmuxIdeaFrontierModelApproval"("id", "provider", "modelId", "version");

CREATE TABLE "AmuxIdeaCollectionRequest" (
    "id" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "ideaId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "sourceScopeApprovalId" TEXT NOT NULL,
    "frontierApprovalId" TEXT NOT NULL,
    "frontierVersion" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "reasoningEffort" TEXT NOT NULL,
    "sourceIndex" INTEGER NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceByteLimit" INTEGER NOT NULL,
    "previewId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "requestDigestKeyId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resultCiphertext" BYTEA,
    "resultKeyId" TEXT,
    "resultKeyVersion" INTEGER,
    "resultDigest" TEXT,
    "resultDigestKeyId" TEXT,
    "resultPurgeAfter" TIMESTAMP(3),
    "resultPurgedAt" TIMESTAMP(3),
    "creationAuditLogId" TEXT NOT NULL,
    "transitionAuditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxIdeaCollectionRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIdeaCollectionRequest_source_kind_check" CHECK (
        "sourceKind" = 'repository_file' AND "sourceByteLimit" = 8192 AND
        "sourceIndex" BETWEEN 0 AND 63
    ),
    CONSTRAINT "AmuxIdeaCollectionRequest_model_check" CHECK (
        "provider" IN ('openai', 'anthropic') AND
        "reasoningEffort" IN ('low', 'medium', 'high', 'xhigh', 'max', 'ultra') AND
        "frontierVersion" > 0 AND "attempt" > 0
    ),
    CONSTRAINT "AmuxIdeaCollectionRequest_request_digest_check" CHECK (
        "requestDigest" ~ '^[a-f0-9]{64}$' AND length("requestDigestKeyId") > 0
    ),
    CONSTRAINT "AmuxIdeaCollectionRequest_state_check" CHECK (
        "state" IN ('pending', 'claimed', 'preview_ready', 'hold', 'expired', 'outcome_unknown')
    ),
    CONSTRAINT "AmuxIdeaCollectionRequest_expiry_check" CHECK (
        "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '15 minutes'
    ),
    CONSTRAINT "AmuxIdeaCollectionRequest_lease_check" CHECK (
        "leaseGeneration" >= 0 AND
        (("state" = 'claimed' AND "leaseGeneration" > 0 AND "leaseId" IS NOT NULL AND
          length("leaseId") > 0 AND "leaseExpiresAt" IS NOT NULL AND
          "leaseExpiresAt" > "createdAt" AND "leaseExpiresAt" <= "expiresAt") OR
         ("state" <> 'claimed' AND "leaseId" IS NULL AND "leaseExpiresAt" IS NULL))
    ),
    CONSTRAINT "AmuxIdeaCollectionRequest_result_pair_check" CHECK (
        ("resultCiphertext" IS NULL AND "resultKeyId" IS NULL AND "resultKeyVersion" IS NULL) OR
        ("resultCiphertext" IS NOT NULL AND octet_length("resultCiphertext") BETWEEN 1 AND 32768 AND
         "resultKeyId" IS NOT NULL AND length("resultKeyId") > 0 AND
         "resultKeyVersion" IS NOT NULL AND "resultKeyVersion" > 0)
    ),
    CONSTRAINT "AmuxIdeaCollectionRequest_result_digest_check" CHECK (
        ("resultDigest" IS NULL AND "resultDigestKeyId" IS NULL) OR
        ("resultDigest" ~ '^[a-f0-9]{64}$' AND "resultDigestKeyId" IS NOT NULL AND
         length("resultDigestKeyId") > 0)
    ),
    CONSTRAINT "AmuxIdeaCollectionRequest_result_state_check" CHECK (
        ("state" <> 'preview_ready' OR
         (("resultCiphertext" IS NOT NULL OR "resultPurgedAt" IS NOT NULL) AND
          "resultDigest" IS NOT NULL AND "resultPurgeAfter" IS NOT NULL)) AND
        ("resultCiphertext" IS NULL OR "state" IN ('preview_ready', 'expired', 'outcome_unknown'))
    ),
    CONSTRAINT "AmuxIdeaCollectionRequest_purge_check" CHECK (
        ("resultPurgeAfter" IS NULL OR
         ("resultPurgeAfter" >= "createdAt" AND
          "resultPurgeAfter" <= "expiresAt" + INTERVAL '24 hours')) AND
        ("resultCiphertext" IS NULL OR "resultPurgeAfter" IS NOT NULL) AND
        ("resultPurgedAt" IS NULL OR
         ("resultCiphertext" IS NULL AND "resultKeyId" IS NULL AND
          "resultKeyVersion" IS NULL AND "resultDigest" IS NOT NULL))
    ),
    CONSTRAINT "AmuxIdeaCollectionRequest_audit_check" CHECK (
        ("state" = 'pending' AND "transitionAuditLogId" IS NULL) OR
        ("state" <> 'pending' AND "transitionAuditLogId" IS NOT NULL AND
         "transitionAuditLogId" <> "creationAuditLogId")
    )
);

CREATE UNIQUE INDEX "AmuxIdeaCollectionRequest_requestId_key"
    ON "AmuxIdeaCollectionRequest"("requestId");
CREATE UNIQUE INDEX "AmuxIdeaCollectionRequest_previewId_key"
    ON "AmuxIdeaCollectionRequest"("previewId");
CREATE UNIQUE INDEX "AmuxIdeaCollectionRequest_attempt_key"
    ON "AmuxIdeaCollectionRequest"("ideaId", "sourceScopeApprovalId", "sourceIndex", "attempt");
CREATE UNIQUE INDEX "AmuxIdeaCollectionRequest_creationAuditLogId_key"
    ON "AmuxIdeaCollectionRequest"("creationAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaCollectionRequest_transitionAuditLogId_key"
    ON "AmuxIdeaCollectionRequest"("transitionAuditLogId");
CREATE INDEX "AmuxIdeaCollectionRequest_state_expiresAt_idx"
    ON "AmuxIdeaCollectionRequest"("state", "expiresAt");
CREATE INDEX "AmuxIdeaCollectionRequest_resultPurgeAfter_resultPurgedAt_idx"
    ON "AmuxIdeaCollectionRequest"("resultPurgeAfter", "resultPurgedAt");

ALTER TABLE "AmuxIdeaCollectionRequest"
    ADD CONSTRAINT "AmuxIdeaCollectionRequest_idea_owner_fkey"
    FOREIGN KEY ("ideaId", "actorUserId")
    REFERENCES "AmuxIdeaSubmission"("id", "actorUserId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxIdeaCollectionRequest"
    ADD CONSTRAINT "AmuxIdeaCollectionRequest_scope_idea_fkey"
    FOREIGN KEY ("sourceScopeApprovalId", "ideaId")
    REFERENCES "AmuxIdeaSourceScopeApproval"("id", "ideaId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxIdeaCollectionRequest"
    ADD CONSTRAINT "AmuxIdeaCollectionRequest_frontier_binding_fkey"
    FOREIGN KEY ("frontierApprovalId", "provider", "modelId", "frontierVersion")
    REFERENCES "AmuxIdeaFrontierModelApproval"("id", "provider", "modelId", "version")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxIdeaCollectionRequest"
    ADD CONSTRAINT "AmuxIdeaCollectionRequest_creationAudit_fkey"
    FOREIGN KEY ("creationAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxIdeaCollectionRequest"
    ADD CONSTRAINT "AmuxIdeaCollectionRequest_transitionAudit_fkey"
    FOREIGN KEY ("transitionAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION amux_v4_collection_request_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'pending' OR NEW."leaseGeneration" <> 0 OR
           NEW."resultCiphertext" IS NOT NULL OR NEW."resultDigest" IS NOT NULL OR
           NEW."resultPurgedAt" IS NOT NULL OR NEW."transitionAuditLogId" IS NOT NULL OR
           clock_timestamp() >= NEW."expiresAt" THEN
            RAISE EXCEPTION 'amux_collection_initial_state_refused';
        END IF;
        RETURN NEW;
    END IF;

    IF ROW(NEW."id", NEW."requestId", NEW."ideaId", NEW."actorUserId",
           NEW."sourceScopeApprovalId", NEW."frontierApprovalId", NEW."frontierVersion",
           NEW."provider", NEW."modelId", NEW."reasoningEffort", NEW."sourceIndex",
           NEW."sourceKind", NEW."sourceByteLimit", NEW."previewId", NEW."attempt",
           NEW."requestDigest", NEW."requestDigestKeyId", NEW."expiresAt",
           NEW."creationAuditLogId", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."requestId", OLD."ideaId", OLD."actorUserId",
           OLD."sourceScopeApprovalId", OLD."frontierApprovalId", OLD."frontierVersion",
           OLD."provider", OLD."modelId", OLD."reasoningEffort", OLD."sourceIndex",
           OLD."sourceKind", OLD."sourceByteLimit", OLD."previewId", OLD."attempt",
           OLD."requestDigest", OLD."requestDigestKeyId", OLD."expiresAt",
           OLD."creationAuditLogId", OLD."createdAt") THEN
        RAISE EXCEPTION 'amux_collection_identity_immutable';
    END IF;
    IF NEW."state" IS DISTINCT FROM OLD."state" THEN
        IF NEW."transitionAuditLogId" IS NOT DISTINCT FROM OLD."transitionAuditLogId" OR
           NOT ((OLD."state" = 'pending' AND NEW."state" IN ('claimed', 'hold', 'expired', 'outcome_unknown')) OR
                (OLD."state" = 'claimed' AND NEW."state" IN ('preview_ready', 'hold', 'expired', 'outcome_unknown')) OR
                (OLD."state" IN ('preview_ready', 'hold') AND NEW."state" = 'expired')) THEN
            RAISE EXCEPTION 'amux_collection_transition_refused';
        END IF;
        IF NEW."state" = 'claimed' AND clock_timestamp() >= NEW."expiresAt" THEN
            RAISE EXCEPTION 'amux_collection_expired_claim_refused';
        END IF;
        IF NEW."state" = 'claimed' AND
           NEW."leaseGeneration" <> OLD."leaseGeneration" + 1 THEN
            RAISE EXCEPTION 'amux_collection_generation_refused';
        END IF;
        IF NEW."state" <> 'claimed' AND
           NEW."leaseGeneration" <> OLD."leaseGeneration" THEN
            RAISE EXCEPTION 'amux_collection_generation_refused';
        END IF;
    ELSE
        IF ROW(NEW."leaseGeneration", NEW."leaseId", NEW."leaseExpiresAt") IS DISTINCT FROM
           ROW(OLD."leaseGeneration", OLD."leaseId", OLD."leaseExpiresAt") THEN
            RAISE EXCEPTION 'amux_collection_same_state_lease_refused';
        END IF;
        IF NEW."transitionAuditLogId" IS DISTINCT FROM OLD."transitionAuditLogId" AND
           NOT (OLD."resultCiphertext" IS NOT NULL AND NEW."resultCiphertext" IS NULL AND
                OLD."resultPurgedAt" IS NULL AND NEW."resultPurgedAt" IS NOT NULL) THEN
            RAISE EXCEPTION 'amux_collection_same_state_audit_refused';
        END IF;
    END IF;
    IF NEW."state" = 'preview_ready' AND OLD."state" <> 'preview_ready' THEN
        IF clock_timestamp() >= NEW."expiresAt" OR
           OLD."leaseExpiresAt" <= clock_timestamp() THEN
            RAISE EXCEPTION 'amux_collection_late_result_refused';
        END IF;
        IF OLD."state" <> 'claimed' OR NEW."resultCiphertext" IS NULL OR
           NEW."resultKeyId" IS NULL OR NEW."resultKeyVersion" IS NULL OR
           NEW."resultDigest" IS NULL OR NEW."resultDigestKeyId" IS NULL OR
           NEW."resultPurgeAfter" IS NULL OR NEW."resultPurgedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'amux_collection_initial_result_required';
        END IF;
    END IF;
    IF NEW."resultPurgedAt" IS DISTINCT FROM OLD."resultPurgedAt" THEN
        IF NEW."state" IS DISTINCT FROM OLD."state" OR
           OLD."resultCiphertext" IS NULL OR NEW."resultCiphertext" IS NOT NULL OR
           OLD."resultPurgedAt" IS NOT NULL OR NEW."resultPurgedAt" IS NULL OR
           NEW."transitionAuditLogId" IS NOT DISTINCT FROM OLD."transitionAuditLogId" THEN
            RAISE EXCEPTION 'amux_collection_purge_audit_refused';
        END IF;
        -- The app cannot backdate a purge. Canonical audit timestamps are UTC
        -- naive timestamps, so use the same DB-clock representation here.
        NEW."resultPurgedAt" := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
        PERFORM 1 FROM "AdminAuditLog" AS audit
         WHERE audit."id" = NEW."transitionAuditLogId" AND
               audit."action" = 'amux.v4.collection.result_purged' AND
               audit."actorUserId" IS NULL AND
               audit."metadata"->>'systemActor' = 'amux-v4-intake' AND
               audit."metadata"->>'actorScope' = 'idea-collection-result-purge-v1' AND
               audit."targetType" = 'AmuxIdeaCollectionRequest' AND
               audit."targetId" = NEW."id" AND
               audit."entryHash" ~ '^[a-f0-9]{64}$' AND
               audit."createdAt" >= (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 minute' AND
               audit."createdAt" <= (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 second' AND
               NEW."resultPurgedAt" >= audit."createdAt" - INTERVAL '1 second' AND
               NEW."resultPurgedAt" <= (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 second'
         FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'amux_collection_purge_audit_refused';
        END IF;
    END IF;
    IF OLD."resultCiphertext" IS NOT NULL AND NEW."resultCiphertext" IS NULL AND
       NEW."resultPurgedAt" IS NULL THEN
        RAISE EXCEPTION 'amux_collection_purge_audit_refused';
    END IF;
    IF OLD."resultPurgedAt" IS NOT NULL AND
       (NEW."resultCiphertext" IS NOT NULL OR NEW."resultKeyId" IS NOT NULL OR
        NEW."resultKeyVersion" IS NOT NULL OR NEW."resultPurgedAt" IS DISTINCT FROM OLD."resultPurgedAt") THEN
        RAISE EXCEPTION 'amux_collection_result_restore_refused';
    END IF;
    IF OLD."resultDigest" IS NOT NULL AND
       (NEW."resultDigest" IS DISTINCT FROM OLD."resultDigest" OR
        NEW."resultDigestKeyId" IS DISTINCT FROM OLD."resultDigestKeyId" OR
        (OLD."resultCiphertext" IS NOT NULL AND NEW."resultCiphertext" IS NOT NULL AND
         NEW."resultCiphertext" IS DISTINCT FROM OLD."resultCiphertext")) THEN
        RAISE EXCEPTION 'amux_collection_result_immutable';
    END IF;
    IF OLD."resultPurgeAfter" IS NOT NULL AND
       (NEW."resultPurgeAfter" IS NULL OR NEW."resultPurgeAfter" > OLD."resultPurgeAfter") THEN
        RAISE EXCEPTION 'amux_collection_purge_deadline_immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaCollectionRequest_guard"
    BEFORE INSERT OR UPDATE ON "AmuxIdeaCollectionRequest"
    FOR EACH ROW EXECUTE FUNCTION amux_v4_collection_request_guard();
