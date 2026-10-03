-- The sre-ops agent's transaction bounds (docs/policy/sre-ops.md §6).
--
-- Two functions, no table. Every ops-observer store transaction calls
-- ops_observer_arm_timeouts() as its first statement; the digest helper is
-- shared by the triggers and checks of later migrations so SQL and code hash
-- the same bytes.
--
-- The arming function has no SET clause and is SECURITY INVOKER: a SET clause
-- would silently revert the settings it makes when it returns, and it needs no
-- privilege. It has no EXCEPTION block: a handler that fires rolls back the
-- settings the function already made. Both are asserted against pg_proc by the
-- integration test.
--
-- transaction_timeout exists from PostgreSQL 17. Its name is passed as text to
-- set_config() and its previous value is read from pg_settings, both inside an
-- IF branch that PL/pgSQL does not execute on 16, so on 16 the name is neither
-- read nor written. Writing it as a literal SET would abort the whole
-- transaction on 16.
--
-- Every system function and view is qualified with pg_catalog, so a caller's
-- search_path cannot substitute its own set_config() or pg_settings and make
-- the function report a timer it never armed. least() and extract() are SQL
-- syntax rather than functions looked up by name, so there is nothing to
-- qualify and nothing a search_path can replace. Every argument is required: a
-- NULL deadline or budget would make each comparison below unknown, and an
-- unknown comparison is skipped, so a NULL is refused before anything is set.

CREATE FUNCTION ops_observer_sha256_hex(input text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(input, 'UTF8')), 'hex')
$$;

CREATE FUNCTION ops_observer_arm_timeouts(
    st_ms         int,          -- statement_timeout
    idle_ms       int,          -- idle_in_transaction_session_timeout
    tt_cap_ms     int,          -- the kind's transaction_timeout constant
    c_guarded_ms  int,          -- the kind's C_guarded
    arm_margin_ms int,          -- margin between computing and setting the timer
    run_deadline  timestamptz,  -- the deadline the caller claims
    OUT "serverVersion"    int,
    OUT "priorTxTimeoutMs" int,         -- NULL on 16
    OUT "txStart"          timestamptz,
    OUT "ttArmedMs"        int,         -- NULL on 16
    OUT "ttArmed"          boolean)
LANGUAGE plpgsql AS $$
DECLARE
  remaining_ms int;
  after_arm    timestamptz;
BEGIN
  IF st_ms IS NULL OR idle_ms IS NULL OR tt_cap_ms IS NULL OR c_guarded_ms IS NULL
     OR arm_margin_ms IS NULL OR run_deadline IS NULL THEN
    RAISE EXCEPTION 'arm_argument_null' USING ERRCODE = 'OB003';
  END IF;

  "serverVersion" := pg_catalog.current_setting('server_version_num')::int;

  PERFORM pg_catalog.set_config('statement_timeout',                   st_ms::text,   true);
  PERFORM pg_catalog.set_config('idle_in_transaction_session_timeout',  idle_ms::text, true);

  "txStart"    := pg_catalog.clock_timestamp();
  remaining_ms := pg_catalog.floor(extract(epoch FROM (run_deadline - "txStart")) * 1000)::int;

  -- Refuse to start without enough budget, on every version.
  IF remaining_ms < c_guarded_ms + arm_margin_ms THEN
    RAISE EXCEPTION 'deadline_budget_insufficient'
      USING ERRCODE = 'OB001', DETAIL = remaining_ms::text;
  END IF;

  IF "serverVersion" >= 170000 THEN
    -- The setting column is a unitless integer in the base unit (ms);
    -- current_setting() would return text with a unit.
    "priorTxTimeoutMs" := (SELECT setting::int FROM pg_catalog.pg_settings
                             WHERE name = 'transaction_timeout');
    -- A positive timer set again to a positive value is not re-armed, so an
    -- inherited timer is turned off first and ours is armed from zero.
    PERFORM pg_catalog.set_config('transaction_timeout', '0', true);
    -- Measured from the clock just before arming, not from txStart.
    "ttArmedMs" := least(tt_cap_ms,
        pg_catalog.floor(extract(epoch FROM (run_deadline - pg_catalog.clock_timestamp())) * 1000)::int
        - arm_margin_ms);
    IF "ttArmedMs" < c_guarded_ms THEN
      RAISE EXCEPTION 'deadline_budget_insufficient'
        USING ERRCODE = 'OB001', DETAIL = "ttArmedMs"::text;
    END IF;
    PERFORM pg_catalog.set_config('transaction_timeout', "ttArmedMs"::text, true);
    -- Postcondition: read after arming, so passing proves expiry <= deadline.
    after_arm := pg_catalog.clock_timestamp();
    IF after_arm + pg_catalog.make_interval(secs => "ttArmedMs" / 1000.0) > run_deadline THEN
      RAISE EXCEPTION 'transaction_timeout_arm_overshoot'
        USING ERRCODE = 'OB002';
    END IF;
    "ttArmed" := true;
  ELSE
    "priorTxTimeoutMs" := NULL;
    "ttArmedMs" := NULL;
    "ttArmed"   := false;
  END IF;
END $$;
