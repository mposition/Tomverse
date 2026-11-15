-- Owner direction 2026-11-15: a session analysis goes on past day seven while
-- its idea's stored deadline allows it. The result guard checked that stored
-- deadline and, again, a fixed seven days after submission; only the fixed
-- clause is removed. A seven-day idea is refused at the same moment as before.
-- baseline-check: replace-function-if-body-sha256 "amux_v19_session_analysis_result_guard" "7966554a8ee10c276104d69fb47b41cdd3d4cbddd9b5ed852777415592d44a55" "5ab2ae1dbad8a74b49759b673cbf7ee37bf2ae4d6fcf030a9be84266e4fa1df3"

BEGIN;

CREATE OR REPLACE FUNCTION "amux_v19_session_analysis_result_guard"() RETURNS trigger
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

COMMIT;
