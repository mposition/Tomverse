-- baseline-check: replace-function-if-body-sha256 "amux_v19_session_analysis_result_guard" "5ab2ae1dbad8a74b49759b673cbf7ee37bf2ae4d6fcf030a9be84266e4fa1df3" "59ff46c0bf807d11c5fd9b2e652456cfdf6b9379004af29b72b400ab2bd51d65"
-- Operator, 2026-11-16: a subscription result that arrives after the system
-- closed its claim unknown at zero is taken instead of dropped. The result
-- row may now name, besides an in-flight claim, a max_shadow claim the system
-- closed that way (nothing reserved, settled at zero, closure audit by the
-- system with closedBy system) while it is its idea's newest claim and the
-- owner did not stop it; the same transaction then settles it
-- (amux_v19_session_budget_claim_guard). The idea, scope, deadline, source
-- evidence and audit checks are unchanged. The function body is the
-- 20261116010900 one with only the claim-state condition replaced.
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
         c."reservedMicroUsd", c."settledMicroUsd",
         (SELECT a."metadata"->>'closedBy' FROM "AdminAuditLog" a
          WHERE a."id" = c."resolutionAuditLogId" AND a."actorUserId" IS NULL AND
            a."entryHash" IS NOT NULL AND
            a."action" = 'amux.v19.session_budget.resolved' AND
            a."metadata"->>'status' = 'owner_consumed' AND
            a."metadata"->>'verification' = 'not_proven') AS closed_by,
         EXISTS (SELECT 1 FROM "AmuxIdeaSessionAnalysisBudgetClaim" n
          WHERE n."reservationId" = c."reservationId" AND
            n."invocationOrdinal" > c."invocationOrdinal") AS has_newer,
         EXISTS (SELECT 1 FROM "AdminAuditLog" s
          WHERE s."action" = 'amux.v19.session_analysis.stopped' AND
            s."targetType" = 'AmuxIdeaSessionAnalysisBudgetClaim' AND
            s."targetId" = c."id"::text) AS owner_stopped,
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
     NOT ((claim_row."status" = 'in_flight' AND claim_row."closedAt" IS NULL AND
           claim_row."resolutionAuditLogId" IS NULL) OR
          (claim_row."status" = 'owner_consumed' AND
           claim_row."reservedMicroUsd" = 0 AND
           claim_row."settledMicroUsd" IS NOT DISTINCT FROM 0 AND
           claim_row."closedAt" IS NOT NULL AND
           claim_row.closed_by IS NOT DISTINCT FROM 'system' AND
           NOT claim_row.has_newer AND NOT claim_row.owner_stopped)) OR
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
