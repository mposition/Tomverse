-- A10 keeps portfolio evidence and score snapshots separate from the legacy
-- scheduler priority. Neither table can mutate a card lifecycle or execute it.
CREATE TABLE "AmuxPortfolioAssessment" (
  "id" UUID NOT NULL PRIMARY KEY,
  "requestId" UUID NOT NULL UNIQUE,
  "nodeId" TEXT,
  "cardId" TEXT,
  "subjectKind" TEXT NOT NULL,
  "subjectRevision" INTEGER NOT NULL,
  "subjectDigest" TEXT NOT NULL,
  "subjectDigestKeyId" TEXT NOT NULL,
  "assessmentVersion" INTEGER NOT NULL,
  "metrics" JSONB NOT NULL,
  "uncertainty" TEXT NOT NULL,
  "evidenceRefs" JSONB NOT NULL,
  "evidenceAsOf" TIMESTAMP(3) NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "modelProposalDigest" TEXT,
  "confirmationDigest" TEXT NOT NULL,
  "confirmationDigestKeyId" TEXT NOT NULL,
  "priorAssessmentId" UUID REFERENCES "AmuxPortfolioAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "approvedByUserId" TEXT NOT NULL,
  "approvalAuditLogId" TEXT NOT NULL UNIQUE REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "approvedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxPortfolioAssessment_node_fkey" FOREIGN KEY ("nodeId") REFERENCES "AmuxPortfolioNode"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxPortfolioAssessment_card_fkey" FOREIGN KEY ("cardId") REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxPortfolioAssessment_shape_check" CHECK (
    (("nodeId" IS NOT NULL AND "cardId" IS NULL AND "subjectKind" IN ('initiative', 'epic', 'feature')) OR
     ("nodeId" IS NULL AND "cardId" IS NOT NULL AND "subjectKind" IN ('story', 'task'))) AND
    "subjectRevision" >= 0 AND "assessmentVersion" >= 1 AND
    "subjectDigest" ~ '^[a-f0-9]{64}$' AND
    "confirmationDigest" ~ '^[a-f0-9]{64}$' AND
    ("modelProposalDigest" IS NULL OR "modelProposalDigest" ~ '^[a-f0-9]{64}$') AND
    jsonb_typeof("metrics") = 'object' AND jsonb_typeof("evidenceRefs") = 'array' AND
    jsonb_array_length("evidenceRefs") BETWEEN 1 AND 16
  )
);
ALTER TABLE "AmuxPortfolioAssessment"
  ADD CONSTRAINT "AmuxPortfolioAssessment_uncertainty_check"
    CHECK ("uncertainty" IN ('low', 'medium', 'high')),
  ADD CONSTRAINT "AmuxPortfolioAssessment_reasonCode_check"
    CHECK ("reasonCode" IN ('initial', 'new_evidence', 'operator_override', 'major_event'));
CREATE UNIQUE INDEX "AmuxPortfolioAssessment_node_version_key"
  ON "AmuxPortfolioAssessment"("nodeId", "assessmentVersion");
CREATE UNIQUE INDEX "AmuxPortfolioAssessment_card_version_key"
  ON "AmuxPortfolioAssessment"("cardId", "assessmentVersion");
CREATE INDEX "AmuxPortfolioAssessment_node_approved_idx"
  ON "AmuxPortfolioAssessment"("nodeId", "approvedAt" DESC);
CREATE INDEX "AmuxPortfolioAssessment_card_approved_idx"
  ON "AmuxPortfolioAssessment"("cardId", "approvedAt" DESC);
CREATE INDEX "AmuxPortfolioAssessment_evidence_idx"
  ON "AmuxPortfolioAssessment"("evidenceAsOf");

CREATE TABLE "AmuxPortfolioScoreSnapshot" (
  "id" UUID NOT NULL PRIMARY KEY,
  "requestId" UUID NOT NULL UNIQUE,
  "taskId" TEXT NOT NULL REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "taskRevision" INTEGER NOT NULL,
  "sourceApprovalId" TEXT NOT NULL,
  "initiativeAssessmentId" UUID NOT NULL REFERENCES "AmuxPortfolioAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "epicAssessmentId" UUID NOT NULL REFERENCES "AmuxPortfolioAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "featureAssessmentId" UUID NOT NULL REFERENCES "AmuxPortfolioAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "storyAssessmentId" UUID REFERENCES "AmuxPortfolioAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "taskAssessmentId" UUID NOT NULL REFERENCES "AmuxPortfolioAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "scoreVersion" TEXT NOT NULL,
  "scoreTotal" INTEGER NOT NULL,
  "components" JSONB NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "inputDigestKeyId" TEXT NOT NULL,
  "evidenceAsOf" TIMESTAMP(3) NOT NULL,
  "activeStaleAt" TIMESTAMP(3) NOT NULL,
  "baselineStaleAt" TIMESTAMP(3) NOT NULL,
  "approvedByUserId" TEXT NOT NULL,
  "approvalAuditLogId" TEXT NOT NULL UNIQUE REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "computedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxPortfolioScoreSnapshot_shape_check" CHECK (
    "taskRevision" >= 0 AND "scoreVersion" = 'amux-v4-portfolio-v1' AND
    "scoreTotal" BETWEEN -100 AND 100 AND jsonb_typeof("components") = 'object' AND
    "inputDigest" ~ '^[a-f0-9]{64}$' AND
    "activeStaleAt" = "evidenceAsOf" + INTERVAL '7 days' AND
    "baselineStaleAt" = "evidenceAsOf" + INTERVAL '28 days' AND
    "computedAt" >= "evidenceAsOf"
  )
);
CREATE INDEX "AmuxPortfolioScoreSnapshot_task_computed_idx"
  ON "AmuxPortfolioScoreSnapshot"("taskId", "computedAt" DESC);
CREATE INDEX "AmuxPortfolioScoreSnapshot_active_idx"
  ON "AmuxPortfolioScoreSnapshot"("activeStaleAt", "taskId");
CREATE INDEX "AmuxPortfolioScoreSnapshot_baseline_idx"
  ON "AmuxPortfolioScoreSnapshot"("baselineStaleAt", "taskId");

CREATE FUNCTION amux_v4_portfolio_valid_rating(metrics jsonb, key text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE value numeric;
BEGIN
  IF jsonb_typeof(metrics -> key) IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;
  value := (metrics ->> key)::numeric;
  RETURN value = trunc(value) AND value BETWEEN 0 AND 5;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
  RETURN false;
END;
$$;

CREATE FUNCTION amux_v4_portfolio_assessment_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE current_kind text; current_revision integer; current_digest text;
        current_key text; current_state text; last_id uuid; last_version integer;
        current_decision_id text;
        audit_actor text; audit_action text; audit_target text; audit_hash text;
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
  SELECT "actorUserId", "action", "targetId", "entryHash"
    INTO audit_actor, audit_action, audit_target, audit_hash
    FROM "AdminAuditLog" WHERE "id" = NEW."approvalAuditLogId" FOR SHARE;
  IF audit_actor IS DISTINCT FROM NEW."approvedByUserId" OR
     audit_action IS DISTINCT FROM 'amux.v4.portfolio.assessment.approve' OR
     audit_target IS DISTINCT FROM NEW."id"::text OR
     audit_hash IS NULL THEN
    RAISE EXCEPTION 'portfolio assessment requires exact owner audit'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioAssessment_audit_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxPortfolioAssessment_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxPortfolioAssessment"
  FOR EACH ROW EXECUTE FUNCTION amux_v4_portfolio_assessment_guard();

CREATE FUNCTION amux_v4_portfolio_score_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE feature_id text; story_id text; task_type text; task_status text;
        task_revision integer; source_id text; epic_id text; initiative_id text;
        ai record; ae record; af record; ast record; atask record;
        story_evidence timestamp; story_version integer;
        story_uncertainty text := 'low';
        story_component integer := 0; task_multiplier integer := 6;
        expected_components jsonb; expected_total integer;
        uncertainty_penalty integer;
        audit_actor text; audit_action text; audit_target text; audit_hash text;
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
  SELECT "actorUserId", "action", "targetId", "entryHash"
    INTO audit_actor, audit_action, audit_target, audit_hash
    FROM "AdminAuditLog" WHERE "id" = NEW."approvalAuditLogId" FOR SHARE;
  IF audit_actor IS DISTINCT FROM NEW."approvedByUserId" OR
     audit_action IS DISTINCT FROM 'amux.v4.portfolio.score.confirm' OR
     audit_target IS DISTINCT FROM NEW."id"::text OR audit_hash IS NULL THEN
    RAISE EXCEPTION 'portfolio score requires exact owner audit'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoreSnapshot_audit_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxPortfolioScoreSnapshot_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxPortfolioScoreSnapshot"
  FOR EACH ROW EXECUTE FUNCTION amux_v4_portfolio_score_guard();

CREATE FUNCTION amux_v4_portfolio_no_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'portfolio scoring history cannot be truncated'
    USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioScoring_no_truncate_check';
END;
$$;
CREATE TRIGGER "AmuxPortfolioAssessment_no_truncate"
  BEFORE TRUNCATE ON "AmuxPortfolioAssessment" FOR EACH STATEMENT
  EXECUTE FUNCTION amux_v4_portfolio_no_truncate();
CREATE TRIGGER "AmuxPortfolioScoreSnapshot_no_truncate"
  BEFORE TRUNCATE ON "AmuxPortfolioScoreSnapshot" FOR EACH STATEMENT
  EXECUTE FUNCTION amux_v4_portfolio_no_truncate();
