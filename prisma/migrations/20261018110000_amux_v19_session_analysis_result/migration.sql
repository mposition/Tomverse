-- One encrypted Max CLI result per exact session budget claim. An insert
-- must bind the same transaction's canonical audit and an active, unexpired
-- claim to already recorded checkout and read-manifest evidence.
BEGIN;

CREATE TABLE "AmuxIdeaSessionAnalysisResult" (
  "claimId" UUID NOT NULL,
  "reservationId" UUID NOT NULL,
  "ideaId" TEXT NOT NULL,
  "referenceOrdinal" INTEGER NOT NULL,
  "evidenceId" UUID NOT NULL,
  "manifestId" UUID NOT NULL,
  "ciphertext" BYTEA,
  "keyId" TEXT,
  "keyVersion" INTEGER,
  "digest" TEXT NOT NULL,
  "digestKeyId" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL,
  "outputTokens" INTEGER NOT NULL,
  "auditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "bodyPurgedAt" TIMESTAMPTZ(3),
  CONSTRAINT "AmuxIdeaSessionAnalysisResult_pkey" PRIMARY KEY ("claimId"),
  CONSTRAINT "AmuxIdeaSessionAnalysisResult_shape_check" CHECK (
    "referenceOrdinal" >= 0 AND "inputTokens" >= 0 AND
    "outputTokens" >= 0 AND
    "inputTokens"::bigint + "outputTokens"::bigint > 0 AND
    "digest" ~ '^[a-f0-9]{64}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND
    (("ciphertext" IS NOT NULL AND
      octet_length("ciphertext") BETWEEN 1 AND 70000 AND
      "keyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND "keyVersion" > 0 AND
      "bodyPurgedAt" IS NULL) OR
     ("ciphertext" IS NULL AND "keyId" IS NULL AND
      "keyVersion" IS NULL AND "bodyPurgedAt" IS NOT NULL))
  )
);

ALTER TABLE "AmuxIdeaContentKeyRetirement"
  DROP CONSTRAINT "AmuxIdeaContentKeyRetirement_purpose_check",
  ADD CONSTRAINT "AmuxIdeaContentKeyRetirement_purpose_check"
    CHECK ("purpose" IN ('idea_raw', 'transfer_payload', 'analysis_freeform',
      'analysis_draft', 'task_result', 'task_patch',
      'repository_read_manifest', 'analysis_result'));

CREATE UNIQUE INDEX "AmuxIdeaSessionAnalysisResult_auditLogId_key"
  ON "AmuxIdeaSessionAnalysisResult"("auditLogId");
CREATE INDEX "AmuxIdeaSessionAnalysisResult_ideaId_createdAt_idx"
  ON "AmuxIdeaSessionAnalysisResult"("ideaId", "createdAt");
CREATE INDEX "AmuxIdeaSessionAnalysisResult_bodyPurgedAt_createdAt_idx"
  ON "AmuxIdeaSessionAnalysisResult"("bodyPurgedAt", "createdAt");

ALTER TABLE "AmuxIdeaSessionAnalysisResult"
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisResult_claimId_fkey"
    FOREIGN KEY ("claimId") REFERENCES "AmuxIdeaSessionAnalysisBudgetClaim"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisResult_ideaId_fkey"
    FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisResult_evidenceId_fkey"
    FOREIGN KEY ("evidenceId") REFERENCES "AmuxIdeaTrackedCheckoutEvidence"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisResult_manifestId_fkey"
    FOREIGN KEY ("manifestId") REFERENCES "AmuxIdeaTrackedCheckoutReadManifest"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisResult_auditLogId_fkey"
    FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "amux_v19_session_analysis_result_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE claim_row record; evidence_row record; manifest_row record;
  audit_row record; metadata jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'session analysis results are append only'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSessionAnalysisResult_append_only';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  SELECT c."reservationId", c."requestId", c."invocationOrdinal",
         c."budgetMode", c."status", c."closedAt", c."resolutionAuditLogId",
         r."ideaId", r."status" AS reservation_status,
         r."operatingScopeSettingId", i."submissionOrigin", i."state" AS idea_state,
         i."cancelledAt", i."analysisCompletedAt", i."analysisDeadlineAt",
         i."submittedAt", i."rawCiphertext", i."rawPurgedAt",
         i."sourceProvenanceCiphertext"
    INTO claim_row FROM "AmuxIdeaSessionAnalysisBudgetClaim" c
    JOIN "AmuxIdeaSessionAnalysisReservation" r ON r."id" = c."reservationId"
    JOIN "AmuxIdeaSubmission" i ON i."id" = r."ideaId"
    WHERE c."id" = NEW."claimId" FOR UPDATE OF c;
  IF NOT FOUND OR claim_row."reservationId" IS DISTINCT FROM NEW."reservationId" OR
     claim_row."ideaId" IS DISTINCT FROM NEW."ideaId" OR
     claim_row."budgetMode" <> 'max_shadow' OR
     claim_row."status" <> 'in_flight' OR claim_row."closedAt" IS NOT NULL OR
     claim_row."resolutionAuditLogId" IS NOT NULL OR
     claim_row.reservation_status <> 'queued' OR
     claim_row."submissionOrigin" <> 'session' OR
     claim_row.idea_state NOT IN ('submitted', 'analyzing') OR
     claim_row."cancelledAt" IS NOT NULL OR
     claim_row."analysisCompletedAt" IS NOT NULL OR
     claim_row."rawCiphertext" IS NULL OR
     claim_row."sourceProvenanceCiphertext" IS NULL OR
     claim_row."rawPurgedAt" IS NOT NULL OR
     claim_row."analysisDeadlineAt" <=
       (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) OR
     (claim_row."submittedAt" + INTERVAL '7 days') AT TIME ZONE 'UTC'
       <= clock_timestamp() OR
     claim_row."operatingScopeSettingId" IS DISTINCT FROM
       (SELECT s."id" FROM "AmuxIdeaOperatingScopeSetting" s
        ORDER BY s."version" DESC LIMIT 1) THEN
    RAISE EXCEPTION 'session analysis result claim is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSessionAnalysisResult_claim_guard';
  END IF;

  SELECT * INTO evidence_row FROM "AmuxIdeaTrackedCheckoutEvidence"
    WHERE "id" = NEW."evidenceId";
  SELECT * INTO manifest_row FROM "AmuxIdeaTrackedCheckoutReadManifest"
    WHERE "id" = NEW."manifestId";
  IF evidence_row."id" IS NULL OR manifest_row."id" IS NULL OR
     evidence_row."ideaId" IS DISTINCT FROM NEW."ideaId" OR
     manifest_row."ideaId" IS DISTINCT FROM NEW."ideaId" OR
     evidence_row."referenceOrdinal" IS DISTINCT FROM NEW."referenceOrdinal" OR
     manifest_row."referenceOrdinal" IS DISTINCT FROM NEW."referenceOrdinal" OR
     evidence_row."pinnedCommitSha" IS DISTINCT FROM
       manifest_row."pinnedCommitSha" OR manifest_row."bodyPurgedAt" IS NOT NULL OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a
       WHERE a."action" = 'amux.v19.tracked_checkout.max_claim_bound'
         AND a."targetType" = 'AmuxIdeaTrackedCheckoutEvidence'
         AND a."targetId" = NEW."evidenceId"::text
         AND a."entryHash" IS NOT NULL AND a."actorUserId" IS NULL
         AND a."metadata"->>'claimId' = NEW."claimId"::text
         AND a."metadata"->>'reservationId' = NEW."reservationId"::text
         AND a."metadata"->>'referenceOrdinal' = NEW."referenceOrdinal"::text) OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a
       WHERE a."action" = 'amux.v19.read_manifest.max_claim_bound'
         AND a."targetType" = 'AmuxIdeaReadManifestKeyIntent'
         AND a."targetId" = NEW."manifestId"::text
         AND a."entryHash" IS NOT NULL AND a."actorUserId" IS NULL
         AND a."metadata"->>'claimId' = NEW."claimId"::text
         AND a."metadata"->>'reservationId' = NEW."reservationId"::text
         AND a."metadata"->>'referenceOrdinal' = NEW."referenceOrdinal"::text) THEN
    RAISE EXCEPTION 'session analysis result lacks claim-bound source evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSessionAnalysisResult_source_guard';
  END IF;

  SELECT * INTO audit_row FROM "AdminAuditLog" WHERE "id" = NEW."auditLogId";
  metadata := audit_row."metadata";
  IF NOT FOUND OR audit_row."entryHash" IS NULL OR
     audit_row.xmin <> pg_current_xact_id()::xid OR
     audit_row."action" <> 'amux.v19.session_analysis.result_recorded' OR
     audit_row."targetType" <> 'AmuxIdeaSessionAnalysisResult' OR
     audit_row."targetId" <> NEW."claimId"::text OR
     audit_row."actorUserId" IS NOT NULL OR
     metadata IS NULL OR jsonb_typeof(metadata) <> 'object' OR
     (SELECT count(*) FROM jsonb_object_keys(metadata)) <> 13 OR
     metadata->>'systemActor' <> 'amux-v4-intake' OR
     metadata->>'actorScope' <> 'session-analysis-result-v1' OR
     metadata->'policyVersion' IS DISTINCT FROM to_jsonb(19) OR
     metadata->>'claimId' IS DISTINCT FROM NEW."claimId"::text OR
     metadata->>'reservationId' IS DISTINCT FROM NEW."reservationId"::text OR
     metadata->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
     metadata->>'referenceOrdinal' IS DISTINCT FROM NEW."referenceOrdinal"::text OR
     metadata->>'evidenceId' IS DISTINCT FROM NEW."evidenceId"::text OR
     metadata->>'manifestId' IS DISTINCT FROM NEW."manifestId"::text OR
     metadata->>'digest' IS DISTINCT FROM NEW."digest" OR
     metadata->>'digestKeyId' IS DISTINCT FROM NEW."digestKeyId" OR
     metadata->>'inputTokens' IS DISTINCT FROM NEW."inputTokens"::text OR
     metadata->>'outputTokens' IS DISTINCT FROM NEW."outputTokens"::text THEN
    RAISE EXCEPTION 'session analysis result audit mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSessionAnalysisResult_audit_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaSessionAnalysisResult_guard"
  BEFORE INSERT ON "AmuxIdeaSessionAnalysisResult"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_session_analysis_result_guard"();

CREATE FUNCTION "amux_v19_session_analysis_result_retention_guard"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE submitted_at timestamp; retirement record; purge_audit record;
  now_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'session analysis result cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSessionAnalysisResult_append_only';
  END IF;
  now_at := clock_timestamp();
  IF OLD."bodyPurgedAt" IS NOT NULL OR
     NEW."claimId" IS DISTINCT FROM OLD."claimId" OR
     NEW."reservationId" IS DISTINCT FROM OLD."reservationId" OR
     NEW."ideaId" IS DISTINCT FROM OLD."ideaId" OR
     NEW."referenceOrdinal" IS DISTINCT FROM OLD."referenceOrdinal" OR
     NEW."evidenceId" IS DISTINCT FROM OLD."evidenceId" OR
     NEW."manifestId" IS DISTINCT FROM OLD."manifestId" OR
     NEW."digest" IS DISTINCT FROM OLD."digest" OR
     NEW."digestKeyId" IS DISTINCT FROM OLD."digestKeyId" OR
     NEW."inputTokens" IS DISTINCT FROM OLD."inputTokens" OR
     NEW."outputTokens" IS DISTINCT FROM OLD."outputTokens" OR
     NEW."auditLogId" IS DISTINCT FROM OLD."auditLogId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     NEW."ciphertext" IS NOT NULL OR NEW."keyId" IS NOT NULL OR
     NEW."keyVersion" IS NOT NULL OR NEW."bodyPurgedAt" IS NULL OR
     NEW."bodyPurgedAt" > now_at THEN
    RAISE EXCEPTION 'session analysis result is append only except verified purge'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSessionAnalysisResult_append_only';
  END IF;
  SELECT "submittedAt" INTO submitted_at FROM "AmuxIdeaSubmission"
    WHERE "id" = NEW."ideaId";
  IF NOT FOUND OR
     (submitted_at + INTERVAL '7 days') AT TIME ZONE 'UTC' >
       NEW."bodyPurgedAt" OR
     EXISTS (SELECT 1 FROM "AmuxIdeaRetentionHold" h
       WHERE h."ideaId" = NEW."ideaId" AND h."releasedAt" IS NULL
         AND h."expiresAt" > now_at) THEN
    RAISE EXCEPTION 'session analysis result retention is not due'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSessionAnalysisResult_retention_due';
  END IF;
  SELECT r."bodyPurgedAt", r."purgeAuditLogId", r.xmin INTO retirement
    FROM "AmuxIdeaContentKeyRetirement" r WHERE r."ideaId" = NEW."ideaId"
      AND r."purpose" = 'analysis_result' AND r."subjectId" = NEW."claimId"::text;
  IF NOT FOUND OR retirement.xmin <> pg_current_xact_id()::xid OR
     retirement."bodyPurgedAt" IS DISTINCT FROM NEW."bodyPurgedAt" THEN
    RAISE EXCEPTION 'session analysis result retirement is missing'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSessionAnalysisResult_retirement_guard';
  END IF;
  SELECT a."action", a."targetType", a."targetId", a."metadata",
         a."entryHash", a.xmin INTO purge_audit FROM "AdminAuditLog" a
    WHERE a."id" = retirement."purgeAuditLogId";
  IF NOT FOUND OR purge_audit.xmin <> pg_current_xact_id()::xid OR
     purge_audit."entryHash" IS NULL OR
     purge_audit."action" <> 'amux.v4.content.body_purged' OR
     purge_audit."targetType" <> 'AmuxIdeaContentKeyRetirement' OR
     purge_audit."targetId" <> NEW."ideaId" || ':analysis_result:' || NEW."claimId"::text OR
     purge_audit."metadata"->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
     purge_audit."metadata"->>'purpose' IS DISTINCT FROM 'analysis_result' OR
     purge_audit."metadata"->>'subjectId' IS DISTINCT FROM NEW."claimId"::text OR
     purge_audit."metadata"->>'digest' IS DISTINCT FROM NEW."digest" OR
     purge_audit."metadata"->>'digestKeyId' IS DISTINCT FROM NEW."digestKeyId" THEN
    RAISE EXCEPTION 'session analysis result purge audit mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSessionAnalysisResult_purge_audit_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaSessionAnalysisResult_retention_guard"
  BEFORE UPDATE OR DELETE ON "AmuxIdeaSessionAnalysisResult"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_session_analysis_result_retention_guard"();

-- The already-durable Max claim is the external key intent. If a key was
-- created but the result transaction never committed, fence its coordinate
-- after the absolute retention deadline before deleting older versions.
CREATE TABLE "AmuxIdeaSessionResultOrphanKeyRetirement" (
  "claimId" UUID NOT NULL PRIMARY KEY,
  "ideaId" TEXT NOT NULL,
  "claimedAt" TIMESTAMPTZ(3) NOT NULL,
  "claimAuditLogId" TEXT NOT NULL UNIQUE,
  "keyDeletedAt" TIMESTAMPTZ(3),
  "keyDeleteAuditLogId" TEXT UNIQUE,
  CONSTRAINT "AmuxIdeaSessionResultOrphanKeyRetirement_state_check"
    CHECK (("keyDeletedAt" IS NULL) = ("keyDeleteAuditLogId" IS NULL)
      AND ("keyDeletedAt" IS NULL OR "keyDeletedAt" >= "claimedAt")),
  CONSTRAINT "AmuxIdeaSessionResultOrphanKeyRetirement_claimId_fkey"
    FOREIGN KEY ("claimId") REFERENCES "AmuxIdeaSessionAnalysisBudgetClaim"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxIdeaSessionResultOrphanKeyRetirement_ideaId_fkey"
    FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxIdeaSessionResultOrphanKeyRetirement_claimAuditLogId_fkey"
    FOREIGN KEY ("claimAuditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxIdeaSessionResultOrphanKeyRetirement_keyDeleteAuditLogId_fkey"
    FOREIGN KEY ("keyDeleteAuditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "AmuxIdeaSessionResultOrphanKeyRetirement_pending_idx"
  ON "AmuxIdeaSessionResultOrphanKeyRetirement"("keyDeletedAt", "claimedAt");

CREATE FUNCTION "amux_v19_session_result_orphan_key_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE claim_row record; audit_row record; now_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orphan result key retirement cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  now_at := clock_timestamp();
  IF TG_OP = 'INSERT' THEN
    SELECT c."budgetMode", c."claimAuditLogId", r."ideaId",
           i."submittedAt" INTO claim_row
      FROM "AmuxIdeaSessionAnalysisBudgetClaim" c
      JOIN "AmuxIdeaSessionAnalysisReservation" r ON r."id" = c."reservationId"
      JOIN "AmuxIdeaSubmission" i ON i."id" = r."ideaId"
      WHERE c."id" = NEW."claimId" FOR UPDATE OF c;
    IF NOT FOUND OR claim_row."budgetMode" <> 'max_shadow' OR
       claim_row."ideaId" IS DISTINCT FROM NEW."ideaId" OR
       (claim_row."submittedAt" + INTERVAL '7 days') AT TIME ZONE 'UTC' >
         NEW."claimedAt" OR NEW."claimedAt" > now_at OR
       NEW."keyDeletedAt" IS NOT NULL OR NEW."keyDeleteAuditLogId" IS NOT NULL OR
       EXISTS (SELECT 1 FROM "AmuxIdeaSessionAnalysisResult" result
         WHERE result."claimId" = NEW."claimId") OR
       EXISTS (SELECT 1 FROM "AmuxIdeaRetentionHold" h
         WHERE h."ideaId" = NEW."ideaId" AND h."releasedAt" IS NULL
           AND h."expiresAt" > now_at) THEN
      RAISE EXCEPTION 'orphan result key is not due'
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO audit_row FROM "AdminAuditLog"
      WHERE "id" = NEW."claimAuditLogId";
    IF NOT FOUND OR audit_row.xmin <> pg_current_xact_id()::xid OR
       audit_row."action" <> 'amux.v19.session_analysis.orphan_key_claimed' OR
       audit_row."targetType" <> 'AmuxIdeaSessionResultOrphanKeyRetirement' OR
       audit_row."targetId" <> NEW."claimId"::text OR
       audit_row."actorUserId" IS NOT NULL OR
       audit_row."entryHash" IS NULL OR
       audit_row."metadata"->>'systemActor' <> 'amux-v4-intake' OR
       audit_row."metadata"->>'actorScope' <> 'session-result-orphan-key-v1' OR
       audit_row."metadata"->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
       audit_row."metadata"->>'claimId' IS DISTINCT FROM NEW."claimId"::text OR
       audit_row."metadata"->>'budgetClaimAuditLogId' IS DISTINCT FROM
         claim_row."claimAuditLogId" THEN
      RAISE EXCEPTION 'orphan result key claim audit mismatch'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."claimId" IS DISTINCT FROM OLD."claimId" OR
     NEW."ideaId" IS DISTINCT FROM OLD."ideaId" OR
     NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt" OR
     NEW."claimAuditLogId" IS DISTINCT FROM OLD."claimAuditLogId" OR
     OLD."keyDeletedAt" IS NOT NULL OR
     NEW."keyDeletedAt" IS NULL OR NEW."keyDeletedAt" > now_at OR
     NEW."keyDeleteAuditLogId" IS NULL OR
     NEW."keyDeletedAt" < OLD."claimedAt" THEN
    RAISE EXCEPTION 'orphan result key retirement is append only'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO audit_row FROM "AdminAuditLog"
    WHERE "id" = NEW."keyDeleteAuditLogId";
  IF NOT FOUND OR audit_row.xmin <> pg_current_xact_id()::xid OR
     audit_row."action" <> 'amux.v19.session_analysis.orphan_key_retired' OR
     audit_row."targetType" <> 'AmuxIdeaSessionResultOrphanKeyRetirement' OR
     audit_row."targetId" <> NEW."claimId"::text OR
     audit_row."actorUserId" IS NOT NULL OR audit_row."entryHash" IS NULL OR
     audit_row."metadata"->>'systemActor' <> 'amux-v4-intake' OR
     audit_row."metadata"->>'actorScope' <> 'session-result-orphan-key-v1' OR
     audit_row."metadata"->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
     audit_row."metadata"->>'claimId' IS DISTINCT FROM NEW."claimId"::text OR
     audit_row."metadata"->>'claimAuditLogId' IS DISTINCT FROM
       OLD."claimAuditLogId" THEN
    RAISE EXCEPTION 'orphan result key delete audit mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxIdeaSessionResultOrphanKeyRetirement_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaSessionResultOrphanKeyRetirement"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_session_result_orphan_key_guard"();

COMMIT;
