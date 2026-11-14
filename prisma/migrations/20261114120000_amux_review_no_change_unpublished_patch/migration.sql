-- AMUX-FILEGEN2-002 (2026-11-13): an implement attempt stored a patch, its
-- engineering run was never created (the publisher was halted), so no
-- publication row existed and the owner completed it as "no change needed".
-- The patch never reached develop and the next cards stopped on code develop
-- did not have. A stored patch is a change: the PR-less approval guard now
-- also refuses a no-change completion of an implement attempt that stored
-- one (lib/amux/reviewApprovalCore.ts amuxV22NoChangeCompletionAllowed, which
-- the app checks first). The owner may still retry the Task or restore its
-- publication. Body replacement only; no table, constraint or row changes.
-- baseline-check: replace-function-if-body-sha256 "amux_review_v4_prless_source_guard" "ef186a96d224ba9b2825fb19c396be7a0246f67164b128e4511449de22ccddb3" "4ff1e546f199eb4715aa334547bedf18f04c1792c49294f6ea90e24e37d173bf"
BEGIN;

CREATE OR REPLACE FUNCTION amux_review_v4_prless_source_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  task_row RECORD;
  result_row RECORD;
  attempt_row RECORD;
  publication_pending BOOLEAN;
  patch_stored BOOLEAN;
BEGIN
  IF NEW."outcome" <> 'approve' OR NEW."reviewPrNumber" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format('SELECT * FROM %I."AmuxWorkItem" WHERE "id" = $1 FOR SHARE',
    TG_TABLE_SCHEMA) INTO task_row USING NEW."taskId";
  IF task_row."id" IS NULL
     OR task_row."sourceSystem" IS DISTINCT FROM 'admin-idea-v4'
     OR task_row."cardType" IS DISTINCT FROM 'task'
     OR task_row."taskRole" IS NULL OR task_row."taskRole" NOT IN
       ('design', 'review', 'verify', 'investigate', 'operate', 'implement')
     OR task_row."reviewPrNumber" IS NOT NULL
     OR task_row."v4TitleDigest" IS NULL
     OR task_row."v4BodyDigest" IS NULL
     OR task_row."v4BriefDigest" IS NULL
     OR task_row."v4TitleCiphertext" IS NULL
     OR task_row."v4BodyCiphertext" IS NULL
     OR task_row."v4BriefCiphertext" IS NULL THEN
    RAISE EXCEPTION 'AMUX PR-less approval requires a v4 non-code Task with retained scope'
      USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE format('SELECT * FROM %I."AmuxV22TaskResult" WHERE "taskId" = $1
    ORDER BY "createdAt" DESC, "attemptId" DESC LIMIT 1 FOR SHARE',
    TG_TABLE_SCHEMA) INTO result_row USING NEW."taskId";
  EXECUTE format('SELECT * FROM %I."AmuxExecutionAttempt"
    WHERE "id" = $1 AND "taskId" = $2 FOR SHARE', TG_TABLE_SCHEMA)
    INTO attempt_row USING NEW."attemptId", NEW."taskId";
  IF result_row."attemptId" IS NULL
     OR result_row."attemptId" IS DISTINCT FROM NEW."attemptId"
     OR result_row."bodyPurgedAt" IS NOT NULL
     OR result_row."ciphertext" IS NULL
     OR result_row."keyId" IS NULL
     OR result_row."keyVersion" IS NULL
     OR attempt_row."id" IS NULL
     OR attempt_row."v22AssignmentId" IS NULL THEN
    RAISE EXCEPTION 'AMUX PR-less approval requires the latest retained v22 result and assignment'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_row."taskRole" = 'implement' THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I."EngineeringAgentWorkItem" item
      JOIN %I."EngineeringAgentRun" run ON run."id" = item."runId"
      WHERE run."amuxAttemptId" = $1 AND (
        (item."kind" = ''publish'' AND item."state" IN
          (''queued'', ''claimed'', ''needs_lookup'', ''outcome_unknown'', ''published''))
        OR (item."kind" = ''t2_draft'' AND item."state" = ''open''
          AND item."reason" = ''tier_pending'')))',
      TG_TABLE_SCHEMA, TG_TABLE_SCHEMA) INTO publication_pending USING NEW."attemptId";
    IF attempt_row."reason" IS NOT DISTINCT FROM 'usage_outcome_unknown'
       OR publication_pending THEN
      RAISE EXCEPTION 'AMUX no-change completion requires a known run with no pull request pending'
        USING ERRCODE = 'check_violation';
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I."AmuxV22TaskPatch"
      WHERE "attemptId" = $1)', TG_TABLE_SCHEMA)
      INTO patch_stored USING NEW."attemptId";
    IF patch_stored THEN
      RAISE EXCEPTION 'AMUX no-change completion refused: the attempt stored a patch no pull request carries'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
