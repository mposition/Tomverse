-- baseline-check: present-if-function "chat_unified_optimizer_deadline_guard"
-- PostgreSQL runs deferred constraint triggers while COMMIT is processing.
-- Recheck the database clock there so a registration, claim or successful
-- evidence write made just before deadline cannot commit as active/successful
-- after it. Unknown and failed closure remain available after the deadline;
-- neither is evidence of a successful run.

CREATE FUNCTION "chat_unified_optimizer_deadline_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_cycle UUID;
  cycle_state TEXT;
  cycle_deadline TIMESTAMPTZ;
BEGIN
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerCycle' THEN
    target_cycle := NEW."id";
  ELSIF TG_TABLE_NAME = 'ChatUnifiedOptimizerRun' THEN
    target_cycle := NEW."cycleId";
  ELSE
    SELECT "cycleId" INTO target_cycle FROM "ChatUnifiedOptimizerRun"
      WHERE "id" = NEW."runId";
  END IF;

  SELECT "state", "deadlineAt" INTO cycle_state, cycle_deadline
  FROM "ChatUnifiedOptimizerCycle" WHERE "id" = target_cycle;

  IF cycle_state IN ('active', 'succeeded')
    AND clock_timestamp() >= cycle_deadline THEN
    RAISE EXCEPTION 'chat_unified_optimizer_deadline_elapsed'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerCycle_deadline"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerCycle"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_deadline_guard"();

CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerRun_deadline"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerRun"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_deadline_guard"();

CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerRoleJob_deadline"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerRoleJob"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_deadline_guard"();
