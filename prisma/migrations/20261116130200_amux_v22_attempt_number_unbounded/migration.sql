-- Owner decision 2026-11-16: a card's platform failures have no count
-- (lib/amux/infraFailureCore.ts), so its attempt numbers have no bound of
-- ours either; it was 64 (20261116011500_amux_v22_attempt_number_bound). The
-- number only has to be positive. Nothing else in the guard changes.
-- baseline-check: replace-function-if-body-sha256 "amux_v22_execution_attempt_guard" "3aa800f701c2d83632e2b6af5c03e8f45c74d151ecd96b6041ef4c71ce79ad53" "e5f0b4f7506f181bca3305c897ef45820d7bef32753999bba789632a2b1ad4d6"
CREATE OR REPLACE FUNCTION amux_v22_execution_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w "AmuxWorkItem"%ROWTYPE;
        assignment "AmuxV22WorkerAssignment"%ROWTYPE;
BEGIN
  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."taskId";
  IF w."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' THEN
    IF NEW."v22AssignmentId" IS NOT NULL THEN
      RAISE EXCEPTION 'non-v4 execution cannot consume v22 assignment'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxExecutionAttempt_v22_binding_check';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO assignment FROM "AmuxV22WorkerAssignment"
    WHERE "id" = NEW."v22AssignmentId" AND "workItemId" = NEW."taskId";
  IF w."cardType" IS DISTINCT FROM 'task' OR assignment."id" IS NULL OR
     NEW."worker" IS DISTINCT FROM assignment."workerName" OR
     NEW."workerInstanceId" IS DISTINCT FROM assignment."workerInstanceId" OR
     NEW."workerGeneration" IS DISTINCT FROM assignment."workerGeneration" OR
     NEW."taskRevision" IS DISTINCT FROM assignment."taskRevision" + 2 OR
     NEW."reservedCostMicrousd" IS DISTINCT FROM assignment."perAttemptMicroUsd" OR
     NEW."attemptNumber" < 1 THEN
    RAISE EXCEPTION 'v22 execution attempt is not assignment-bound'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxExecutionAttempt_v22_binding_check';
  END IF;
  IF NEW."endedAt" IS NULL AND
     (w."status" IS DISTINCT FROM 'doing' OR
      w."v22AssignmentId" IS DISTINCT FROM assignment."id" OR
      w."owner" IS DISTINCT FROM assignment."workerName" OR
      w."revision" IS DISTINCT FROM NEW."taskRevision") THEN
    RAISE EXCEPTION 'live v22 execution requires matching task state'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxExecutionAttempt_v22_binding_check';
  END IF;
  IF TG_OP = 'UPDATE' AND
     (NEW."v22AssignmentId" IS DISTINCT FROM OLD."v22AssignmentId" OR
      NEW."taskId" IS DISTINCT FROM OLD."taskId" OR
      NEW."worker" IS DISTINCT FROM OLD."worker" OR
      NEW."workerInstanceId" IS DISTINCT FROM OLD."workerInstanceId" OR
      NEW."workerGeneration" IS DISTINCT FROM OLD."workerGeneration" OR
      NEW."taskRevision" IS DISTINCT FROM OLD."taskRevision" OR
      NEW."attemptNumber" IS DISTINCT FROM OLD."attemptNumber" OR
      NEW."reservedCostMicrousd" IS DISTINCT FROM OLD."reservedCostMicrousd") THEN
    RAISE EXCEPTION 'v22 execution identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxExecutionAttempt_v22_binding_check';
  END IF;
  RETURN NEW;
END $$;
