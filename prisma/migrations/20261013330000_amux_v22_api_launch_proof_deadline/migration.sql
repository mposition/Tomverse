-- baseline-check: present-if-function "amux_v22_v42_api_launch_proof_deadline_guard"
-- Policy v42: model-access evidence records the DB time of its own report, so a
-- late report of a cached result could carry claim/start up to 90 seconds past
-- the launch proof it answered. Bind claim (assignment) and start (attempt) of
-- an API recovery to the original launch proof's 90-second window as well.
-- Additive only: migrations 290/300 and their functions are unchanged.
BEGIN;

CREATE FUNCTION amux_v22_v42_api_launch_proof_deadline_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  assignment "AmuxV22WorkerAssignment"%ROWTYPE;
  approval "AmuxV22TaskRecoveryApproval"%ROWTYPE;
  proof "AmuxV22ReadOnlyLaunchProof"%ROWTYPE;
  approval_id UUID;
  db_now TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
  IF TG_TABLE_NAME = 'AmuxV22WorkerAssignment' THEN
    approval_id := NEW."recoveryApprovalId";
  ELSE
    IF NEW."v22AssignmentId" IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO assignment FROM "AmuxV22WorkerAssignment"
      WHERE "id" = NEW."v22AssignmentId" FOR KEY SHARE;
    approval_id := assignment."recoveryApprovalId";
  END IF;
  IF approval_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO approval FROM "AmuxV22TaskRecoveryApproval"
    WHERE "id" = approval_id FOR KEY SHARE;
  IF approval."launchProofId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO proof FROM "AmuxV22ReadOnlyLaunchProof"
    WHERE "id" = approval."launchProofId" FOR KEY SHARE;
  IF proof."report" #>> '{launchScope,executorKind}' IS DISTINCT FROM
       'read_only_api_retry_v1' THEN
    RETURN NEW;
  END IF;
  IF proof."recordedAt" > db_now OR
     db_now - proof."recordedAt" > INTERVAL '90 seconds' THEN
    RAISE EXCEPTION 'API recovery claim or start is past its launch proof deadline'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22Recovery_api_launch_proof_deadline_check';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER amux_v22_v42_assignment_launch_proof_deadline BEFORE INSERT
  ON "AmuxV22WorkerAssignment" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_v42_api_launch_proof_deadline_guard();

CREATE CONSTRAINT TRIGGER amux_v22_v42_attempt_launch_proof_deadline
  AFTER INSERT ON "AmuxExecutionAttempt" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION amux_v22_v42_api_launch_proof_deadline_guard();

COMMIT;
