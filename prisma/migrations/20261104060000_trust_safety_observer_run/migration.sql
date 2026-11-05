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
-- **What the deferred trigger does not bind, measured.** A transaction may
-- send `SET CONSTRAINTS trust_safety_observer_run_deadline_check IMMEDIATE`
-- (or `ALL IMMEDIATE`), which fires the pending check at that point; it passes
-- while the deadline still holds, is not queued again, and the transaction can
-- then run past the deadline and commit with the row intact. Verified on a
-- throwaway 17.10 cluster: the row lands, and the same transaction without
-- that statement is refused with TS002.
--
-- So the device holds against a transaction that does not send that statement,
-- and what keeps this agent's transactions in that class is the application
-- side: the statement set of E1 and E3 is fixed and counted (§5.5's ceiling),
-- the raw-SQL allowlist pins its shape and number (§5.6 item 3), and a test
-- holds `SET CONSTRAINTS` out of every one of this agent's own files. It is
-- not a defence against arbitrary SQL in the product database -- a party who
-- can send that can also disable the trigger or drop it, and §5.4 never
-- claimed otherwise.
--
-- The same cluster showed what would close it on 17: a `transaction_timeout`
-- armed at the deadline terminates such a transaction before COMMIT, leaving
-- no row. Arming it there instead of at `C_guarded + 3s` changes §12 (1) table
-- B's approved gap, which only the operator signs, so it is recorded for that
-- signature rather than done here.
--
-- What this does not guarantee (§5.4 states it, so this comment does not
-- overclaim): that COMMIT finishes before the deadline. The pre-commit and
-- durability phases are not bounded on any PostgreSQL version. The success
-- instant is defined as the moment the trigger passed; the row's visibility
-- may be later, and observedAt/recordedAt are still set by the database clock
-- before commit, so the row does not state a false time.
--
-- Nothing is turned on here. No row is written and no service reads this.

-- The deadline is read from one place, and its format is constrained rather
-- than described. `named::timestamptz` alone resolves an offset-less string in
-- the session's TimeZone, which would make the late-commit judgement depend on
-- a session setting -- the same value would be early in one session and late
-- in another. Requiring an explicit offset removes that: a value without one
-- is refused rather than guessed.
CREATE FUNCTION trust_safety_parse_deadline(named text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- The whole shape, not just the suffix. Checking only the tail accepted a
  -- bare date: '2026-11-04' ends in '-04', which reads as an offset, and the
  -- cast then resolves midnight in the session's TimeZone -- exactly the
  -- dependency the check exists to remove.
  IF named !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
    RAISE EXCEPTION 'trust_safety_deadline_malformed' USING ERRCODE = 'TS008';
  END IF;
  RETURN named::timestamptz;
END $$;

CREATE TABLE "TrustSafetyObserverRun" (
    "id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    -- Overwritten by the BEFORE INSERT trigger below, so the application
    -- cannot set it. The column is NOT NULL and the trigger always assigns,
    -- so an insert that omits it is still complete.
    "recordedAt" TIMESTAMPTZ(3) NOT NULL,
    -- The deadline this round must commit inside, taken from the setting at
    -- INSERT and fixed here. The deferred trigger reads this column and never
    -- the setting: re-reading it would let the transaction extend its own
    -- deadline, and deriving the deadline from `recordedAt` instead would let
    -- a round that inserted late overrun the real one. Both were found by
    -- independent review; §5.3 records why the column exists.
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,

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
-- The deadline's reach is fixed here, at statement time, and only its expiry
-- is judged at COMMIT. Checking "at most 9 seconds ahead" in the deferred
-- trigger instead would not enforce the approved deadline at all: a caller
-- could name a deadline 30 seconds out, insert, and commit 25 seconds later --
-- 5 seconds still remain, so the deferred check passes and the transaction
-- occupied far longer than table C allows.
CREATE FUNCTION trust_safety_observer_run_recorded_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  named   text;
  claimed timestamptz;
BEGIN
  named := current_setting('trust_safety.run_deadline', true);
  IF named IS NULL OR named = '' THEN
    RAISE EXCEPTION 'trust_safety_run_deadline_missing' USING ERRCODE = 'TS001';
  END IF;
  -- Called with its schema named, as the other observer triggers do: this
  -- function runs with search_path pinned to pg_catalog, so an unqualified
  -- call cannot find a function in the table's own schema.
  EXECUTE format('SELECT %I.trust_safety_parse_deadline($1)', TG_TABLE_SCHEMA)
    INTO claimed USING named;
  IF claimed > clock_timestamp() + interval '9 seconds' THEN
    RAISE EXCEPTION 'trust_safety_run_deadline_too_far' USING ERRCODE = 'TS004';
  END IF;
  -- A deadline already in the past is refused here rather than at COMMIT. The
  -- reach check above only bounds how far ahead it may be, so without this an
  -- expired deadline would insert and the row would be judged against a
  -- deadline that never had any time left.
  IF claimed <= clock_timestamp() THEN
    RAISE EXCEPTION 'trust_safety_run_deadline_expired' USING ERRCODE = 'TS002';
  END IF;
  NEW."recordedAt" := clock_timestamp();
  -- Fixed from the value just validated. The application's value is
  -- overwritten, so it cannot supply its own deadline.
  NEW."deadlineAt" := claimed;
  RETURN NEW;
END $$;

CREATE TRIGGER trust_safety_observer_run_recorded_at
    BEFORE INSERT ON "TrustSafetyObserverRun"
    FOR EACH ROW EXECUTE FUNCTION trust_safety_observer_run_recorded_at();

-- Append-only. §5.3 calls the row a record and says no judgement reads this
-- table, so there is nothing to amend; §7's retention schedule is not approved
-- yet and "예외가 지금 면제하는 삭제는 하나도 없다", so no delete path is opened
-- either. Without these, an UPDATE would reach neither the clock overwrite nor
-- the deadline checks above, and a recorded success could be rewritten after
-- the fact.
CREATE FUNCTION trust_safety_observer_run_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'trust_safety_run_is_append_only' USING ERRCODE = 'TS007';
END $$;

CREATE TRIGGER trust_safety_observer_run_append_only
    BEFORE UPDATE OR DELETE ON "TrustSafetyObserverRun"
    FOR EACH ROW EXECUTE FUNCTION trust_safety_observer_run_append_only();

-- The §5.4 judgement, at COMMIT.
CREATE FUNCTION trust_safety_observer_run_deadline_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  now_utc timestamptz;
BEGIN
  now_utc := clock_timestamp();

  -- The deadline that was validated at INSERT, read from the row. Two other
  -- shapes were tried and each had a hole: re-reading the setting let the
  -- transaction extend its own deadline, and `recordedAt + 9s` let a round
  -- that inserted eight seconds in overrun the real deadline by committing two
  -- seconds later. The column is written by the BEFORE INSERT trigger and the
  -- row is append-only, so this value is both the real deadline and immovable.
  IF now_utc > NEW."deadlineAt" THEN
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
