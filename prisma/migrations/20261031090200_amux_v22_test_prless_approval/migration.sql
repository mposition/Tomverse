-- Owner decision 2026-10-30: a test Task runs as an implement execution and
-- leaves a patch, so like an implement Task it completes through a GitHub pull
-- request. Its retained result no longer substitutes for PR evidence. This
-- replaces the PR-less approval guard body only at its role list. No table,
-- constraint or row changes.
-- baseline-check: replace-function-if-body-sha256 "amux_review_v4_prless_source_guard" "590e81a6e33ad4cc412b6f60e99fb39ce118565832a41845083e38dc26ca4d9b"
BEGIN;

CREATE OR REPLACE FUNCTION amux_review_v4_prless_source_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  task_row RECORD;
  result_row RECORD;
  attempt_row RECORD;
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
       ('design', 'review', 'verify', 'investigate', 'operate')
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
  RETURN NEW;
END;
$$;

COMMIT;
