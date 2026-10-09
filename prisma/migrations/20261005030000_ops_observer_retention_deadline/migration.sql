-- The retention deadline of the sre-ops reservations (docs/policy/sre-ops.md
-- §6 item 5, §10).
--
-- baseline-check: present-if-function "ops_observer_retention_deadline_check"
--
-- Every other ops-observer write carries its run deadline on the row, and a
-- deferred constraint trigger refuses the COMMIT once the database clock is
-- past it. A retention batch only deletes, so the deleted row has no deadline
-- of its own to check. The batch therefore names its deadline in the
-- transaction-local setting ops_observer.retention_deadline, and this one
-- deferred trigger, run at COMMIT for every deleted reservation:
--
--   1. refuses a delete whose transaction named no deadline (OB013), so no
--      delete escapes the check by leaving the setting out;
--   2. holds the named deadline to the same claim every row passes (at most
--      180 seconds ahead);
--   3. refuses the COMMIT once the database clock is past it (OB012, the
--      same late-commit refusal as the other tables).
--
-- The delete guard's own rules (never a reserved row, never one closed less
-- than ninety days ago) are unchanged. Nothing is written and nothing is
-- turned on.

CREATE FUNCTION ops_observer_retention_deadline_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  named   text;
  claimed timestamptz;
BEGIN
  named := current_setting('ops_observer.retention_deadline', true);
  IF named IS NULL OR named = '' THEN
    RAISE EXCEPTION 'ops_observer_retention_deadline_missing' USING ERRCODE = 'OB013';
  END IF;
  claimed := named::timestamptz;
  EXECUTE format('SELECT %I.ops_observer_deadline_claim($1)', TG_TABLE_SCHEMA) USING claimed;
  IF clock_timestamp() > claimed THEN
    RAISE EXCEPTION 'ops_observer_late_commit' USING ERRCODE = 'OB012';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ops_observer_delivery_retention_deadline_check
    AFTER DELETE ON "OpsObserverDelivery"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ops_observer_retention_deadline_check();
