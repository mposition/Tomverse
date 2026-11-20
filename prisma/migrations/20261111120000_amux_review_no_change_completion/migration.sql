-- Owner decision 2026-11-11 (AMUX-ARTFMT-002): an implement Task whose v22
-- worker found the change already in place and left none reaches review with
-- no pull request. Block kept it in the owner queue for ever and nothing else
-- could close it. The owner may now complete it as "no change needed" after
-- reading the worker report and the current code; it is stored as the existing
-- approve outcome (review -> done) with no pull request, and the audit entry
-- names the basis (lib/amux/reviewApproval.ts).
--
-- This replaces the PR-less approval guard body only. The non-code roles keep
-- their exact checks. An implement Task is admitted only when the bound
-- attempt's usage outcome is known and no engineering publication work has
-- opened, or may still open, a pull request for that attempt: a publish item
-- that is waiting, in flight or published, or a draft whose tier is pending
-- (AMUX_REVIEW_PUBLICATION_PENDING_STATES, amuxReviewPublicationMayOpenPr).
-- The publication rows are read without a lock, as the app reads them: the
-- publisher takes the audit chain lock before its own rows. No table,
-- constraint or row changes.
-- baseline-check: replace-function-if-body-sha256 "amux_review_v4_prless_source_guard" "25a35c09e6ac0f8499de3fdaadd76327241003053e8d5055e451458bcece7a71" "ef186a96d224ba9b2825fb19c396be7a0246f67164b128e4511449de22ccddb3"
BEGIN;

CREATE OR REPLACE FUNCTION amux_review_v4_prless_source_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  task_row RECORD;
  result_row RECORD;
  attempt_row RECORD;
  publication_pending BOOLEAN;
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
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
