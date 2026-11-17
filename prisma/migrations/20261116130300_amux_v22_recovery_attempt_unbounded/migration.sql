-- Owner decision 2026-11-16: an owner's recovery retry names the card's next
-- attempt number, which has no bound of ours (it was 64,
-- 20261116011600_amux_v22_recovery_attempt_bound); it only has to be positive.
-- The exact one-attempt authority the guard checks is unchanged.
-- baseline-check: replace-function-if-body-sha256 "amux_v22_recovery_attempt_guard" "c50de03d1fca6243581c0b9e1d2a3ad24a07d7cd4b988201028dabbb095fd02f" "aec90867cf65eefc7f65b5141f65bc8929e56ffd1d388137384e3567532aecd7"
CREATE OR REPLACE FUNCTION amux_v22_recovery_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE assignment "AmuxV22WorkerAssignment"%ROWTYPE;
 recovery "AmuxV22TaskRecoveryApproval"%ROWTYPE;
 attempt_count INTEGER; held BIGINT;
BEGIN
  SELECT * INTO assignment FROM "AmuxV22WorkerAssignment" WHERE "id" = NEW."v22AssignmentId" AND "workItemId" = NEW."taskId";
  IF assignment."recoveryApprovalId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO recovery FROM "AmuxV22TaskRecoveryApproval" WHERE "id" = assignment."recoveryApprovalId";
  SELECT count(*)::integer, coalesce(sum("reservedCostMicrousd"),0)
    INTO attempt_count, held FROM "AmuxExecutionAttempt" WHERE "taskId" = NEW."taskId";
  IF recovery."id" IS NULL OR recovery."taskId" IS DISTINCT FROM NEW."taskId" OR
     recovery."afterRevision" IS DISTINCT FROM assignment."taskRevision" OR
     recovery."nextAttemptNumber" < 1 OR
     NEW."attemptNumber" IS DISTINCT FROM recovery."nextAttemptNumber" OR
     NEW."reservedCostMicrousd" <= 0 OR NEW."reservedCostMicrousd" > recovery."additionalCapMicroUsd" OR
     attempt_count IS DISTINCT FROM recovery."historicalAttempts" + 1 OR
     held IS DISTINCT FROM recovery."oldHeldMicroUsd" + NEW."reservedCostMicrousd" THEN
    RAISE EXCEPTION 'Recovery attempt does not consume its exact one-attempt authority'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryAttempt_binding_check';
  END IF;
  RETURN NEW;
END $$;
