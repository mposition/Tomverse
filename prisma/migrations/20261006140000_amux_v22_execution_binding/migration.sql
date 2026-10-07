BEGIN;

-- A v22 assignment is only a reservation. One server-minted execution
-- attempt may consume it; a second start cannot silently reuse it.
ALTER TABLE "AmuxExecutionAttempt"
  ADD COLUMN "v22AssignmentId" UUID UNIQUE;
ALTER TABLE "AmuxExecutionAttempt"
  ADD CONSTRAINT "AmuxExecutionAttempt_v22AssignmentId_fkey"
  FOREIGN KEY ("v22AssignmentId") REFERENCES "AmuxV22WorkerAssignment"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
CREATE UNIQUE INDEX "AmuxExecutionAttempt_v22_one_live_per_task_idx"
  ON "AmuxExecutionAttempt" ("taskId")
  WHERE "v22AssignmentId" IS NOT NULL AND "endedAt" IS NULL;

ALTER TABLE "AmuxWorkItem"
  DROP CONSTRAINT "AmuxWorkItem_v4_phase_b_inert_check",
  ADD CONSTRAINT "AmuxWorkItem_v4_execution_shape_check"
  CHECK ("sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
    (("cardType" = 'story' AND "status" IN
       ('backlog', 'blocked', 'cancelled', 'done') AND
       "owner" IS NULL AND "claimedAt" IS NULL AND "v22AssignmentId" IS NULL) OR
     ("cardType" = 'task' AND
      (("status" IN ('backlog', 'review', 'blocked', 'cancelled', 'done') AND
        "owner" IS NULL AND "claimedAt" IS NULL AND "v22AssignmentId" IS NULL) OR
       ("status" = 'todo' AND
        (("owner" IS NULL AND "claimedAt" IS NULL AND "v22AssignmentId" IS NULL) OR
         ("owner" IS NOT NULL AND "claimedAt" IS NOT NULL AND "v22AssignmentId" IS NOT NULL))) OR
       ("status" = 'doing' AND "owner" IS NOT NULL AND
        "claimedAt" IS NOT NULL AND "v22AssignmentId" IS NOT NULL))))) NOT VALID;

CREATE FUNCTION amux_v22_execution_attempt_guard() RETURNS trigger
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
     NEW."attemptNumber" NOT BETWEEN 1 AND 5 THEN
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
CREATE CONSTRAINT TRIGGER amux_v22_execution_attempt_guard_trigger
AFTER INSERT OR UPDATE ON "AmuxExecutionAttempt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION amux_v22_execution_attempt_guard();

CREATE FUNCTION amux_v22_doing_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w "AmuxWorkItem"%ROWTYPE;
BEGIN
  -- Deferred events from an earlier state of this same row must inspect the
  -- final transaction state, not the NEW image captured at that earlier write.
  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."id";
  IF w."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
     w."cardType" IS DISTINCT FROM 'task' THEN RETURN NEW; END IF;
  IF w."status" IS DISTINCT FROM 'doing' THEN
    IF EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a
      WHERE a."taskId" = w."id" AND a."v22AssignmentId" IS NOT NULL
        AND a."endedAt" IS NULL) THEN
      RAISE EXCEPTION 'live v22 attempt cannot leave task doing'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxWorkItem_v22_live_attempt_check';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "AmuxExecutionAttempt" a
    WHERE a."taskId" = w."id" AND
      a."v22AssignmentId" = w."v22AssignmentId" AND
      a."worker" = w."owner" AND
      a."taskRevision" = w."revision" AND a."endedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'v22 doing requires one live assignment-bound attempt'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxWorkItem_v22_doing_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_doing_guard_trigger
AFTER INSERT OR UPDATE ON "AmuxWorkItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION amux_v22_doing_guard();

ALTER TABLE "AmuxExecutionAttempt" VALIDATE CONSTRAINT "AmuxExecutionAttempt_v22AssignmentId_fkey";
ALTER TABLE "AmuxWorkItem" VALIDATE CONSTRAINT "AmuxWorkItem_v4_execution_shape_check";
COMMIT;
