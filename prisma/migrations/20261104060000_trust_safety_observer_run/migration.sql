-- The trust-safety observer's run row (docs/policy/trust-safety-compliance-agent.md
-- §5.3, §5.4; the deadline and window values are §12 (1) table C).
--
-- baseline-check: present-if-relation "TrustSafetyObserverRun"
--
-- Four columns and nothing else. §5.3 fixes them: id, outcome, observedAt,
-- recordedAt, with no free text, reason, count, error message or user
-- reference column. `outcome` has one allowed value so the schema itself says
-- "this table holds successes only", and there is no idempotency key -- two
-- overlapping runs are two true sentences, so the row count is "successful
-- runs" and never a denominator.
--
-- Nothing reads this table. That is what makes the row a record rather than
-- state (§5.3): if reading code appears, or `outcome` gains a second value or
-- a reason column, it has become state and the design changes with it.
--
-- §5.4 is the one thing the database must enforce: a run that finished late is
-- not recorded as a success. Two clocks decide it, both at COMMIT:
--
--   1. the transaction's deadline, which the caller names in the
--      transaction-local setting trust_safety.run_deadline. A write that named
--      none is a failed write, not an unchecked one (TS001), so leaving the
--      setting out cannot escape the check. The named value is held to the
--      same claim every row passes -- at most 9 seconds ahead (§12 (1) table
--      C: the run row's deadline is that kind's C_guarded, 3 x 3s) -- so a
--      caller cannot buy time by naming a distant one (TS004).
--   2. the round's own window, clock_timestamp() - "observedAt" against 47
--      seconds (table C's round window, a free proposed value with a derived
--      floor of 34s). The deadline alone is not enough: a run that spent a
--      long time in the earlier stages would still commit inside its last
--      transaction's deadline and be recorded as a success (§5.4).
--
-- Both are judged by a DEFERRABLE INITIALLY DEFERRED constraint trigger, which
-- §5.4 requires: a BEFORE or AFTER immediate trigger passes at statement time
-- and the transaction can still commit after the deadline. The route also
-- computes the same window at statement time for `pingPermitted`, but the
-- binding judgement is this one.
--
-- What this does not guarantee (§5.4 states it, so this comment does not
-- overclaim): that COMMIT finishes before the deadline. The pre-commit and
-- durability phases are not bounded on any PostgreSQL version. The success
-- instant is defined as the moment the trigger passed; the row's visibility
-- may be later, and observedAt/recordedAt are still set by the database clock
-- before commit, so the row does not state a false time.
--
-- Nothing is turned on here. No row is written and no service reads this.

CREATE TABLE "TrustSafetyObserverRun" (
    "id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    -- Overwritten by the BEFORE INSERT trigger below, so the application
    -- cannot set it. The column is NOT NULL and the trigger always assigns,
    -- so an insert that omits it is still complete.
    "recordedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TrustSafetyObserverRun_pkey" PRIMARY KEY ("id")
);

-- One allowed value: the table holds successes only (§5.3).
ALTER TABLE "TrustSafetyObserverRun"
    ADD CONSTRAINT "TrustSafetyObserverRun_outcome_succeeded_check"
    CHECK ("outcome" = 'succeeded');

-- Refuses a future observation time (§5.3).
ALTER TABLE "TrustSafetyObserverRun"
    ADD CONSTRAINT "TrustSafetyObserverRun_observed_before_recorded_check"
    CHECK ("observedAt" <= "recordedAt");

-- `recordedAt` is the database's clock, not the caller's (§5.3). The columns
-- are timestamptz, as the other observer tables are, so the clock is stored
-- and compared without an AT TIME ZONE conversion -- a naive column would be
-- re-interpreted in the session time zone, and the cast to TIMESTAMP(3) also
-- rounds, which has made `>` comparisons against clock_timestamp() flake here
-- before.
CREATE FUNCTION trust_safety_observer_run_recorded_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW."recordedAt" := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER trust_safety_observer_run_recorded_at
    BEFORE INSERT ON "TrustSafetyObserverRun"
    FOR EACH ROW EXECUTE FUNCTION trust_safety_observer_run_recorded_at();

-- The §5.4 judgement, at COMMIT.
CREATE FUNCTION trust_safety_observer_run_deadline_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  named     text;
  claimed   timestamptz;
  now_utc   timestamptz;
BEGIN
  named := current_setting('trust_safety.run_deadline', true);
  IF named IS NULL OR named = '' THEN
    RAISE EXCEPTION 'trust_safety_run_deadline_missing' USING ERRCODE = 'TS001';
  END IF;
  claimed := named::timestamptz;
  now_utc := clock_timestamp();

  -- The caller names the deadline but does not get to choose how far ahead it
  -- is: 9 seconds is the run row's approved deadline (§12 (1) table C).
  IF claimed > now_utc + interval '9 seconds' THEN
    RAISE EXCEPTION 'trust_safety_run_deadline_too_far' USING ERRCODE = 'TS004';
  END IF;

  IF now_utc > claimed THEN
    RAISE EXCEPTION 'trust_safety_run_late_commit' USING ERRCODE = 'TS002';
  END IF;

  -- The round's own window, which the deadline does not cover (§5.4).
  IF now_utc - NEW."observedAt" > interval '47 seconds' THEN
    RAISE EXCEPTION 'trust_safety_run_window_exceeded' USING ERRCODE = 'TS003';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trust_safety_observer_run_deadline_check
    AFTER INSERT ON "TrustSafetyObserverRun"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trust_safety_observer_run_deadline_check();
