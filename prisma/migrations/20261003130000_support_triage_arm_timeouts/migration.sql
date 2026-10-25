-- Support-triage transaction timeouts (docs/policy/support-triage.md §4).
--
-- baseline-check: present-if-function "support_triage_arm_timeouts"
--
-- support_triage_arm_timeouts() is the first round trip of every support-triage
-- transaction. In that one call it reads the server version, the inherited
-- session transaction_timeout and the database clock, then arms
-- statement_timeout and idle_in_transaction_session_timeout and, on
-- PostgreSQL 17 only and only when the session inherited 0, transaction_timeout,
-- all transaction-local. A positive inherited transaction_timeout is left as it
-- is: its timer started with the transaction and set_config would not move it,
-- only make the reported setting disagree with the timer that actually runs.
-- The caller refuses the transaction when that inherited value is at or below
-- the lane's largest C_guarded (docs/policy/support-triage.md §4, Q22).
--
-- Three rules this function must keep, each checked by
-- tests/integration/support-triage-timeouts.db.test.ts:
--
--   * No SET clause. A SET clause is restored when the function returns, so
--     any setting it names would silently stop applying to the rest of the
--     transaction (pg_proc.proconfig must stay NULL).
--   * SECURITY INVOKER (prosecdef = false): it needs no privilege of its own.
--   * No EXCEPTION handler. A handler runs the body in a subtransaction, and a
--     failure inside it must abort the caller's transaction rather than be
--     swallowed.
--
-- transaction_timeout is named through set_config() and pg_settings, never as
-- a bare GUC literal: PostgreSQL 16 does not know the name, and an IF branch
-- that is not taken is never executed, so the same function runs on 16 and 17.
-- With no SET clause, every call is schema-qualified to pg_catalog instead.
-- This migration writes no row.

BEGIN;

CREATE OR REPLACE FUNCTION "support_triage_arm_timeouts"(
    statement_ms INTEGER,
    idle_ms INTEGER,
    transaction_ms INTEGER
)
RETURNS TABLE (
    "serverVersionNum" INTEGER,
    "inheritedTransactionTimeoutMs" INTEGER,
    "nowUtc" TIMESTAMP(3)
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $$
DECLARE
    version_num INTEGER := pg_catalog.current_setting('server_version_num')::INTEGER;
    inherited INTEGER;
BEGIN
    IF statement_ms IS NULL OR idle_ms IS NULL OR transaction_ms IS NULL
        OR statement_ms <= 0 OR idle_ms <= 0 OR transaction_ms <= 0
        OR NOT (transaction_ms > statement_ms AND statement_ms > idle_ms) THEN
        RAISE EXCEPTION 'support_triage_arm_timeouts needs transaction > statement > idle > 0'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF version_num >= 170000 THEN
        -- Read before arming: this is the value the transaction started under.
        SELECT s.setting::INTEGER INTO inherited
          FROM pg_catalog.pg_settings s
         WHERE s.name = 'transaction_timeout';
    END IF;

    PERFORM pg_catalog.set_config('statement_timeout', statement_ms::TEXT, true);
    PERFORM pg_catalog.set_config('idle_in_transaction_session_timeout', idle_ms::TEXT, true);
    IF version_num >= 170000 AND inherited = 0 THEN
        PERFORM pg_catalog.set_config('transaction_timeout', transaction_ms::TEXT, true);
    END IF;

    RETURN QUERY SELECT
        version_num,
        inherited,
        (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
END;
$$;

COMMIT;
