-- Intake v19 item 5: permit exact system registration assessment evidence.
-- baseline-check: replace-function-if-body-sha256 "amux_v4_portfolio_assessment_guard" "879e14d52e8ab0ec9e9be667c19eb7fea851068d2c778a4fe8943420e1942c87"
CREATE OR REPLACE FUNCTION amux_v4_portfolio_assessment_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE current_kind text; current_revision integer; current_digest text;
        current_key text; current_state text; last_id uuid; last_version integer;
        current_decision_id text;
        audit_actor text; audit_action text; audit_target_type text;
        audit_target text; audit_hash text; audit_system_actor text;
        audit_actor_scope text; audit_registration_authority text;
        audit_same_transaction boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'portfolio assessment is append only'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioAssessment_immutable_check';
  END IF;
  -- The trigger's schema is the only authority. pg_temp comes last so a
  -- same-named temporary table cannot answer a guard query.
  PERFORM set_config('search_path',
    format('pg_catalog,%I,pg_temp', TG_TABLE_SCHEMA), true);
  IF NEW."nodeId" IS NOT NULL THEN
    SELECT "level", "revision", "contentDigest", "contentDigestKeyId", "state"
      INTO current_kind, current_revision, current_digest, current_key, current_state
      FROM "AmuxPortfolioNode" WHERE "id" = NEW."nodeId" FOR UPDATE;
    IF current_state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'portfolio node is not active'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioAssessment_subject_check';
    END IF;
    SELECT "decisionId" INTO current_decision_id
      FROM "AmuxPortfolioNodeRevision"
      WHERE "nodeId" = NEW."nodeId" AND "revision" = current_revision;
  ELSE
    SELECT "cardType", "revision", "v4BodyDigest", "v4BodyDigestKeyId", "status"
      INTO current_kind, current_revision, current_digest, current_key, current_state
      FROM "AmuxWorkItem" WHERE "id" = NEW."cardId"
        AND "sourceSystem" = 'admin-idea-v4' FOR UPDATE;
    IF current_state IS NULL OR current_state IN ('done', 'cancelled') THEN
      RAISE EXCEPTION 'portfolio card is not active v4'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioAssessment_subject_check';
    END IF;
    SELECT "v4SourceApprovalId" INTO current_decision_id
      FROM "AmuxWorkItem" WHERE "id" = NEW."cardId";
  END IF;
  IF current_kind IS DISTINCT FROM NEW."subjectKind" OR
     current_revision IS DISTINCT FROM NEW."subjectRevision" OR
     current_digest IS DISTINCT FROM NEW."subjectDigest" OR
     current_key IS DISTINCT FROM NEW."subjectDigestKeyId" OR
     NEW."evidenceAsOf" > (clock_timestamp() AT TIME ZONE 'UTC') OR
     NEW."approvedAt" > (clock_timestamp() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'portfolio assessment binding or clock changed'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioAssessment_binding_check';
  END IF;
  IF NEW."modelProposalDigest" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "AmuxIdeaUnitDecision" decision
      JOIN "AmuxIdeaDraftUnit" unit ON unit."id" = decision."draftUnitId"
    WHERE decision."id" = current_decision_id AND
      decision."state" = 'consumed' AND unit."state" = 'approved' AND
      unit."bodyDigest" = NEW."modelProposalDigest"
  ) THEN
    RAISE EXCEPTION 'portfolio model proposal is not an approved source unit'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioAssessment_model_binding_check';
  END IF;
  IF (NEW."subjectKind" IN ('initiative', 'epic', 'feature') AND
      (NEW."metrics" - 'value' <> '{}'::jsonb OR
       NOT amux_v4_portfolio_valid_rating(NEW."metrics", 'value'))) OR
     (NEW."subjectKind" = 'story' AND
      (NEW."metrics" - 'impact' <> '{}'::jsonb OR
       NOT amux_v4_portfolio_valid_rating(NEW."metrics", 'impact'))) OR
     (NEW."subjectKind" = 'task' AND
      (NEW."metrics" - 'contribution' - 'urgency' - 'dependencyUnlock' -
       'workerCoverage' - 'effort' - 'deliveryRisk' <> '{}'::jsonb OR
       NOT amux_v4_portfolio_valid_rating(NEW."metrics", 'contribution') OR
       NOT amux_v4_portfolio_valid_rating(NEW."metrics", 'urgency') OR
       NOT amux_v4_portfolio_valid_rating(NEW."metrics", 'dependencyUnlock') OR
       NOT amux_v4_portfolio_valid_rating(NEW."metrics", 'workerCoverage') OR
       NOT amux_v4_portfolio_valid_rating(NEW."metrics", 'effort') OR
       NOT amux_v4_portfolio_valid_rating(NEW."metrics", 'deliveryRisk'))) OR
     EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."evidenceRefs") AS ref(value)
       WHERE ref.value !~ '^[A-Za-z0-9:_-]{8,128}$') OR
     (SELECT count(DISTINCT ref.value) FROM jsonb_array_elements_text(
       NEW."evidenceRefs") AS ref(value)) <> jsonb_array_length(NEW."evidenceRefs") THEN
    RAISE EXCEPTION 'portfolio assessment metrics or evidence refs invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioAssessment_metrics_check';
  END IF;
  SELECT "id", "assessmentVersion" INTO last_id, last_version
    FROM "AmuxPortfolioAssessment"
    WHERE (NEW."nodeId" IS NOT NULL AND "nodeId" = NEW."nodeId") OR
          (NEW."cardId" IS NOT NULL AND "cardId" = NEW."cardId")
    ORDER BY "assessmentVersion" DESC LIMIT 1;
  IF NEW."assessmentVersion" IS DISTINCT FROM COALESCE(last_version, 0) + 1 OR
     NEW."priorAssessmentId" IS DISTINCT FROM last_id OR
     (last_id IS NULL AND NEW."reasonCode" <> 'initial') OR
     (last_id IS NOT NULL AND NEW."reasonCode" = 'initial') THEN
    RAISE EXCEPTION 'portfolio assessment version chain changed'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioAssessment_version_check';
  END IF;
  SELECT "actorUserId", "action", "targetType", "targetId", "entryHash",
         "metadata"->>'systemActor', "metadata"->>'actorScope',
         "metadata"->>'registrationAuthority',
         xmin = pg_current_xact_id()::xid
    INTO audit_actor, audit_action, audit_target_type, audit_target, audit_hash,
         audit_system_actor, audit_actor_scope, audit_registration_authority,
         audit_same_transaction
    FROM "AdminAuditLog" WHERE "id" = NEW."approvalAuditLogId" FOR SHARE;
  IF audit_action IS DISTINCT FROM 'amux.v4.portfolio.assessment.approve' OR
     audit_target IS DISTINCT FROM NEW."id"::text OR
     NOT ((audit_actor = NEW."approvedByUserId" AND audit_system_actor IS NULL AND
           audit_hash IS NOT NULL) OR
          (audit_actor IS NULL AND audit_system_actor = 'amux-v4-intake' AND
           audit_same_transaction IS TRUE AND
           audit_target_type = 'AmuxPortfolioAssessment' AND
           audit_hash ~ '^[a-f0-9]{64}$' AND
           audit_actor_scope = 'system-portfolio-assessment-v1' AND
           audit_registration_authority = 'system')) THEN
    RAISE EXCEPTION 'portfolio assessment requires exact registration audit'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioAssessment_audit_check';
  END IF;
  RETURN NEW;
END;
$$;
