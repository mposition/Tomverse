-- Support-triage deadline check (docs/policy/support-triage.md §4).
--
-- baseline-check: present-if-function "support_triage_assert_deadline"
--
-- support_triage_assert_deadline() is the last round trip of every
-- support-triage mutation transaction other than finishing a run. It reads the
-- database clock once and raises when the run's deadline has passed, so the
-- whole transaction -- its rows and its audit entry -- rolls back and a late
-- run is never recorded as having done the work. A NULL deadline also raises:
-- a transaction that does not know its deadline does not get to commit.
--
-- Same shape as support_triage_arm_timeouts(): no SET clause, SECURITY
-- INVOKER, no EXCEPTION handler, every call schema-qualified. This migration
-- writes no row.

BEGIN;

CREATE OR REPLACE FUNCTION "support_triage_assert_deadline"(deadline TIMESTAMP(3))
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $$
BEGIN
    IF deadline IS NULL
        OR (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC') > deadline THEN
        RAISE EXCEPTION 'support_triage_deadline_passed'
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

COMMIT;
