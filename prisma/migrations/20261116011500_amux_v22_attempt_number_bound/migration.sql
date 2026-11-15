-- Owner direction 2026-11-15: a card no longer stops at five attempts, and a
-- run that failed on the platform keeps its attempt number but does not count
-- (lib/amux/infraFailureCore.ts, lib/amux/executionBudgetCore.ts). The v22
-- attempt guard still refused any attempt number above five, so the sixth
-- execution start of a card with infrastructure failures would fail at
-- commit. The bound is now 64: the app's runaway guard of thirty counted
-- attempts plus twelve infrastructure failures, with room to spare. Nothing
-- else in the guard changes.
-- baseline-check: replace-function-if-body-sha256 "amux_v22_execution_attempt_guard" "72b6211f7c75eb91007df25005c23c83a02de9857c425184ded621d5f44cafcb" "3aa800f701c2d83632e2b6af5c03e8f45c74d151ecd96b6041ef4c71ce79ad53"
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
     NEW."attemptNumber" NOT BETWEEN 1 AND 64 THEN
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
