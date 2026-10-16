-- Intake v19 item 5: permit exact system registration score evidence.
-- baseline-check: replace-function-if-body-sha256 "amux_v4_portfolio_score_guard" "6da7d53e028b4fab1e52a0448513789b254013a988804ed920fee227961b4917"
CREATE OR REPLACE FUNCTION amux_v4_portfolio_score_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE feature_id text; story_id text; task_type text; task_status text;
        task_revision integer; source_id text; epic_id text; initiative_id text;
        ai record; ae record; af record; ast record; atask record;
        story_evidence timestamp; story_version integer;
        story_uncertainty text := 'low';
        story_component integer := 0; task_multiplier integer := 6;
        expected_components jsonb; expected_total integer;
        uncertainty_penalty integer;
        audit_actor text; audit_action text; audit_target_type text;
        audit_target text; audit_hash text; audit_system_actor text;
        audit_actor_scope text; audit_registration_authority text;
        audit_same_transaction boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'portfolio score is append only'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_immutable_check';
  END IF;
  PERFORM set_config('search_path',
    format('pg_catalog,%I,pg_temp', TG_TABLE_SCHEMA), true);
  SELECT "cardType", "status", "revision", "parentFeatureNodeId",
         "parentStoryCardId", "v4SourceApprovalId"
    INTO task_type, task_status, task_revision, feature_id, story_id, source_id
    FROM "AmuxWorkItem" WHERE "id" = NEW."taskId"
      AND "sourceSystem" = 'admin-idea-v4' FOR SHARE;
  IF task_type IS DISTINCT FROM 'task' OR
     task_status IS NULL OR task_status IN ('done', 'cancelled') OR
     task_revision IS DISTINCT FROM NEW."taskRevision" OR
     source_id IS DISTINCT FROM NEW."sourceApprovalId" OR
     feature_id IS NULL THEN
    RAISE EXCEPTION 'portfolio score task binding changed'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_task_check';
  END IF;
  SELECT "parentId" INTO epic_id FROM "AmuxPortfolioNode"
    WHERE "id" = feature_id AND "level" = 'feature' AND "state" = 'active' FOR SHARE;
  SELECT "parentId" INTO initiative_id FROM "AmuxPortfolioNode"
    WHERE "id" = epic_id AND "level" = 'epic' AND "state" = 'active' FOR SHARE;
  IF initiative_id IS NULL OR NOT EXISTS (SELECT 1 FROM "AmuxPortfolioNode"
      WHERE "id" = initiative_id AND "level" = 'initiative' AND "state" = 'active') THEN
    RAISE EXCEPTION 'portfolio score hierarchy changed'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_hierarchy_check';
  END IF;
  IF story_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "AmuxWorkItem"
      WHERE "id" = story_id AND "cardType" = 'story' AND
        "parentFeatureNodeId" = feature_id AND "sourceSystem" = 'admin-idea-v4') THEN
    RAISE EXCEPTION 'portfolio score Story changed'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_story_check';
  END IF;
  SELECT * INTO ai FROM "AmuxPortfolioAssessment" WHERE "id" = NEW."initiativeAssessmentId";
  SELECT * INTO ae FROM "AmuxPortfolioAssessment" WHERE "id" = NEW."epicAssessmentId";
  SELECT * INTO af FROM "AmuxPortfolioAssessment" WHERE "id" = NEW."featureAssessmentId";
  SELECT * INTO atask FROM "AmuxPortfolioAssessment" WHERE "id" = NEW."taskAssessmentId";
  IF story_id IS NOT NULL THEN
    SELECT * INTO ast FROM "AmuxPortfolioAssessment" WHERE "id" = NEW."storyAssessmentId";
    story_evidence := ast."evidenceAsOf";
    story_version := ast."assessmentVersion";
    story_uncertainty := ast."uncertainty";
    story_component := (ast."metrics" ->> 'impact')::integer * 2;
    task_multiplier := 4;
    IF NEW."storyAssessmentId" IS NULL OR
       ast."cardId" IS DISTINCT FROM story_id OR ast."subjectKind" IS DISTINCT FROM 'story' THEN
      RAISE EXCEPTION 'portfolio score Story assessment changed'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_assessments_check';
    END IF;
  ELSIF NEW."storyAssessmentId" IS NOT NULL THEN
    RAISE EXCEPTION 'portfolio score unexpected Story assessment'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_assessments_check';
  END IF;
  IF ai."nodeId" IS DISTINCT FROM initiative_id OR ai."subjectKind" <> 'initiative' OR
     ae."nodeId" IS DISTINCT FROM epic_id OR ae."subjectKind" <> 'epic' OR
     af."nodeId" IS DISTINCT FROM feature_id OR af."subjectKind" <> 'feature' OR
     atask."cardId" IS DISTINCT FROM NEW."taskId" OR atask."subjectKind" <> 'task' THEN
    RAISE EXCEPTION 'portfolio score assessment path changed'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_assessments_check';
  END IF;
  IF EXISTS (SELECT 1 FROM "AmuxPortfolioNode" n
      JOIN "AmuxPortfolioAssessment" a ON a."nodeId" = n."id"
      WHERE a."id" IN (NEW."initiativeAssessmentId", NEW."epicAssessmentId",
                       NEW."featureAssessmentId") AND
        (a."subjectRevision" <> n."revision" OR
         a."subjectDigest" <> n."contentDigest" OR
         a."subjectDigestKeyId" <> n."contentDigestKeyId" OR n."state" <> 'active')) OR
     EXISTS (SELECT 1 FROM "AmuxWorkItem" c
      JOIN "AmuxPortfolioAssessment" a ON a."cardId" = c."id"
      WHERE a."id" IN (NEW."taskAssessmentId", NEW."storyAssessmentId") AND
        (a."subjectRevision" <> c."revision" OR
         a."subjectDigest" <> c."v4BodyDigest" OR
         a."subjectDigestKeyId" <> c."v4BodyDigestKeyId" OR
         c."status" IN ('done', 'cancelled'))) THEN
    RAISE EXCEPTION 'portfolio score assessment subject was revised'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_subject_revision_check';
  END IF;
  IF EXISTS (SELECT 1 FROM "AmuxPortfolioAssessment" newer
    WHERE (newer."nodeId" = initiative_id AND newer."assessmentVersion" > ai."assessmentVersion") OR
          (newer."nodeId" = epic_id AND newer."assessmentVersion" > ae."assessmentVersion") OR
          (newer."nodeId" = feature_id AND newer."assessmentVersion" > af."assessmentVersion") OR
          (story_id IS NOT NULL AND newer."cardId" = story_id AND newer."assessmentVersion" > story_version) OR
          (newer."cardId" = NEW."taskId" AND newer."assessmentVersion" > atask."assessmentVersion")) THEN
    RAISE EXCEPTION 'portfolio score assessment is superseded'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_latest_check';
  END IF;
  IF NEW."evidenceAsOf" IS DISTINCT FROM LEAST(ai."evidenceAsOf", ae."evidenceAsOf",
      af."evidenceAsOf", atask."evidenceAsOf", COALESCE(story_evidence, atask."evidenceAsOf")) THEN
    RAISE EXCEPTION 'portfolio score evidence clock changed'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_evidence_clock_check';
  END IF;
  uncertainty_penalty := CASE
    WHEN 'high' IN (ai."uncertainty", ae."uncertainty", af."uncertainty",
                    atask."uncertainty", story_uncertainty) THEN 10
    WHEN 'medium' IN (ai."uncertainty", ae."uncertainty", af."uncertainty",
                      atask."uncertainty", story_uncertainty) THEN 5
    ELSE 0 END;
  expected_components := jsonb_build_object(
    'initiative', (ai."metrics" ->> 'value')::integer * 4,
    'epic', (ae."metrics" ->> 'value')::integer * 3,
    'feature', (af."metrics" ->> 'value')::integer * 2,
    'story', story_component,
    'task', (atask."metrics" ->> 'contribution')::integer * task_multiplier,
    'urgency', (atask."metrics" ->> 'urgency')::integer * 2,
    'dependency', (atask."metrics" ->> 'dependencyUnlock')::integer,
    'worker', (atask."metrics" ->> 'workerCoverage')::integer,
    'effortPenalty', (atask."metrics" ->> 'effort')::integer * 2,
    'riskPenalty', (atask."metrics" ->> 'deliveryRisk')::integer,
    'uncertaintyPenalty', uncertainty_penalty);
  expected_total :=
    (expected_components ->> 'initiative')::integer +
    (expected_components ->> 'epic')::integer +
    (expected_components ->> 'feature')::integer +
    (expected_components ->> 'story')::integer +
    (expected_components ->> 'task')::integer +
    (expected_components ->> 'urgency')::integer +
    (expected_components ->> 'dependency')::integer +
    (expected_components ->> 'worker')::integer -
    (expected_components ->> 'effortPenalty')::integer -
    (expected_components ->> 'riskPenalty')::integer -
    uncertainty_penalty;
  IF NEW."components" IS DISTINCT FROM expected_components OR
     NEW."scoreTotal" IS DISTINCT FROM expected_total THEN
    RAISE EXCEPTION 'portfolio score differs from confirmed evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_calculation_check';
  END IF;
  SELECT "actorUserId", "action", "targetType", "targetId", "entryHash",
         "metadata"->>'systemActor', "metadata"->>'actorScope',
         "metadata"->>'registrationAuthority',
         xmin = pg_current_xact_id()::xid
    INTO audit_actor, audit_action, audit_target_type, audit_target, audit_hash,
         audit_system_actor, audit_actor_scope, audit_registration_authority,
         audit_same_transaction
    FROM "AdminAuditLog" WHERE "id" = NEW."approvalAuditLogId" FOR SHARE;
  IF audit_action IS DISTINCT FROM 'amux.v4.portfolio.score.confirm' OR
     audit_target IS DISTINCT FROM NEW."id"::text OR
     NOT ((audit_actor = NEW."approvedByUserId" AND audit_system_actor IS NULL AND
           audit_hash IS NOT NULL) OR
          (audit_actor IS NULL AND audit_system_actor = 'amux-v4-intake' AND
           audit_same_transaction IS TRUE AND
           audit_target_type = 'AmuxPortfolioScoreSnapshot' AND
           audit_hash ~ '^[a-f0-9]{64}$' AND
           audit_actor_scope = 'system-portfolio-score-v1' AND
           audit_registration_authority = 'system')) THEN
    RAISE EXCEPTION 'portfolio score requires exact registration audit'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_audit_check';
  END IF;
  RETURN NEW;
END;
$$;
