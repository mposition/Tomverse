-- baseline-check: replace-function-if-body-sha256 "amux_v22_v39_attempt_guard" "5fd506041790421b0bdc83a5ab87fc5b7c769988da8d944200e632326d8c1fd6"
-- Policy v39 caps this exact FIRST Task at two total paid attempts. Serialize
-- every new attempt for it, then require its second attempt to consume the one
-- approved read-only recovery. Other Tasks retain the global five-attempt cap.
BEGIN;

CREATE OR REPLACE FUNCTION amux_v22_v39_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  assignment "AmuxV22WorkerAssignment"%ROWTYPE;
  approval "AmuxV22TaskRecoveryApproval"%ROWTYPE;
  attempt_count INTEGER;
BEGIN
  IF NEW."taskId" = 'c48886b9-86f8-4631-8db8-c0b288a707af' THEN
    IF pg_catalog.current_setting('transaction_isolation') NOT IN
       ('read committed', 'read uncommitted', 'serializable') THEN
      RAISE EXCEPTION 'FIRST Task attempt isolation must be read committed or serializable'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxV22RecoveryAttempt_v39_limit_check';
    END IF;
    -- Match the application writers' global-first, Task-second lock order. The
    -- deferred trigger then sees any concurrent attempt that committed first.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('tomverse-amux-admission'));
    PERFORM 1 FROM "AmuxWorkItem"
      WHERE "id" = NEW."taskId" FOR UPDATE;
    SELECT count(*)::integer INTO attempt_count
      FROM "AmuxExecutionAttempt" WHERE "taskId" = NEW."taskId";

    IF attempt_count > 2 OR
       NEW."attemptNumber" IS DISTINCT FROM attempt_count THEN
      RAISE EXCEPTION 'FIRST Task permits no more than two ordered attempts'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxV22RecoveryAttempt_v39_limit_check';
    END IF;

    IF NEW."attemptNumber" = 2 THEN
      SELECT * INTO assignment FROM "AmuxV22WorkerAssignment"
        WHERE "id" = NEW."v22AssignmentId"
          AND "workItemId" = NEW."taskId";
      SELECT * INTO approval FROM "AmuxV22TaskRecoveryApproval"
        WHERE "id" = assignment."recoveryApprovalId";
      IF assignment."id" IS NULL OR approval."id" IS NULL OR
         approval."riskAcceptanceId" IS NULL OR
         approval."taskId" IS DISTINCT FROM NEW."taskId" OR
         approval."priorAttemptId" IS DISTINCT FROM
           '97858395-3d66-42fa-9bfb-0e5a6cba9bd8' OR
         approval."historicalAttempts" IS DISTINCT FROM 1 OR
         approval."nextAttemptNumber" IS DISTINCT FROM 2 OR
         NEW."reservedCostMicrousd" IS DISTINCT FROM
           approval."additionalCapMicroUsd" THEN
        RAISE EXCEPTION 'FIRST Task second attempt requires its exact read-only approval'
          USING ERRCODE = '23514',
            CONSTRAINT = 'AmuxV22RecoveryAttempt_v39_limit_check';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Preserve the original v39 recovery-approval guard for every other Task,
  -- including its cross-Task, attempt-number and reserved-cap rejection.
  IF NEW."v22AssignmentId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO assignment FROM "AmuxV22WorkerAssignment"
    WHERE "id" = NEW."v22AssignmentId";
  IF assignment."recoveryApprovalId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO approval FROM "AmuxV22TaskRecoveryApproval"
    WHERE "id" = assignment."recoveryApprovalId";
  IF approval."riskAcceptanceId" IS NOT NULL AND
     (NEW."taskId" IS DISTINCT FROM approval."taskId" OR
      NEW."attemptNumber" IS DISTINCT FROM 2 OR
      NEW."reservedCostMicrousd" IS DISTINCT FROM
        approval."additionalCapMicroUsd" OR
      (SELECT count(*) FROM "AmuxExecutionAttempt" attempt
        WHERE attempt."taskId" = NEW."taskId") > 2) THEN
    RAISE EXCEPTION 'FIRST Task permits exactly one additional capped attempt'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22RecoveryAttempt_v39_limit_check';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
