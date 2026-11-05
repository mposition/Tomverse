-- The trust-safety observer's activation row
-- (docs/policy/trust-safety-compliance-agent.md §5.1 item 1, §6).
--
-- baseline-check: present-if-relation "TrustSafetyObserverConfig"
--
-- One row, written only by a person's Admin action (§5.1). The observer never
-- writes it, and never believes it on its own: §6 derives the mode from the
-- newest audit entry for `trust_safety.observer_activation_changed` and
-- accepts this row's `mode` only when all seven checks pass. That is what
-- stops a replayed historical tuple from turning observation on, so this table
-- is deliberately not the authority -- it is one of the two things the
-- derivation compares.
--
-- `mode` has exactly the two values §6 allows. The CHECK is what makes a third
-- one impossible rather than merely unexpected; the derivation still refuses a
-- value outside the two, because a row written around a constraint is not a
-- third mode.
--
-- `version` is the monotonic counter §6 binds the audit entry to
-- (`metadata.version`). It is not a schema version and not a policy version.
--
-- Single row by constraint, not by convention: a second row would give the
-- derivation two answers with no rule for choosing, and "the newest" is not
-- defined here -- the audit chain is where order lives.
--
-- Nothing is written here by this migration and nothing is turned on. The row
-- arrives when an operator first changes the mode (E3, §5.6), in the same
-- transaction as its audit entry.

CREATE TABLE "TrustSafetyObserverConfig" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    -- The deadline this write must commit inside, written by the trigger below
    -- from the database clock. It is a column rather than a re-read of the
    -- setting because the same transaction could otherwise extend it: write
    -- under a valid 24-second deadline, call set_config with a distant one,
    -- and commit later. Stored, it cannot move.
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TrustSafetyObserverConfig_pkey" PRIMARY KEY ("id")
);

-- §6: the only two values.
ALTER TABLE "TrustSafetyObserverConfig"
    ADD CONSTRAINT "TrustSafetyObserverConfig_mode_check"
    CHECK ("mode" IN ('off', 'on'));

-- §5.1: a single row.
ALTER TABLE "TrustSafetyObserverConfig"
    ADD CONSTRAINT "TrustSafetyObserverConfig_singleton_check"
    CHECK ("id" = 'singleton');

-- The counter only moves forward. A version that went backwards would let an
-- older audit entry become the bound one again, which is the replay §6's check
-- 5 refuses on the read side; refusing it on the write side too means the two
-- sides cannot disagree.
ALTER TABLE "TrustSafetyObserverConfig"
    ADD CONSTRAINT "TrustSafetyObserverConfig_version_positive_check"
    CHECK ("version" >= 1);

CREATE FUNCTION trust_safety_observer_config_version_forward() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."version" <= OLD."version" THEN
    RAISE EXCEPTION 'trust_safety_config_version_not_forward' USING ERRCODE = 'TS005';
  END IF;
  IF NEW."mode" = OLD."mode" THEN
    -- §6: the only transitions are off → on and on → off. Re-requesting the
    -- current mode is refused and writes nothing; the route refuses it with a
    -- 409, and this is the same rule where it cannot be bypassed.
    RAISE EXCEPTION 'trust_safety_config_mode_unchanged' USING ERRCODE = 'TS006';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trust_safety_observer_config_version_forward
    BEFORE UPDATE ON "TrustSafetyObserverConfig"
    FOR EACH ROW EXECUTE FUNCTION trust_safety_observer_config_version_forward();

-- §5.4 requires the deadline judgement on both writing paths, and this is the
-- other one: "사람의 activation 쓰기: DEFERRABLE INITIALLY DEFERRED constraint
-- trigger가 COMMIT 처리 중 DB 시계로 마감을 판정한다". Without it a write that
-- named no deadline, or one held open for minutes, would still commit as long
-- as the mode and version were right.
--
-- 24 seconds is this kind's approved deadline (§12 (1) table C: the activation
-- write's C_deadline = its C_guarded = 8 x 3s), and the reach is fixed at
-- statement time for the same reason as the run row -- checking it at COMMIT
-- would measure what is left rather than what was granted.
CREATE FUNCTION trust_safety_observer_config_deadline_reach() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  named   text;
  claimed timestamptz;
BEGIN
  named := current_setting('trust_safety.activation_deadline', true);
  IF named IS NULL OR named = '' THEN
    RAISE EXCEPTION 'trust_safety_activation_deadline_missing' USING ERRCODE = 'TS001';
  END IF;
  -- Called with its schema named, as the other observer triggers do: this
  -- function runs with search_path pinned to pg_catalog, so an unqualified
  -- call cannot find a function in the table's own schema.
  EXECUTE format('SELECT %I.trust_safety_parse_deadline($1)', TG_TABLE_SCHEMA)
    INTO claimed USING named;
  IF claimed > clock_timestamp() + interval '24 seconds' THEN
    RAISE EXCEPTION 'trust_safety_activation_deadline_too_far' USING ERRCODE = 'TS004';
  END IF;
  -- An already-expired deadline is refused here, as the run row's trigger
  -- does. The reach check above only bounds how far ahead it may be, so
  -- without this the write proceeds on a deadline with no time left and holds
  -- the transaction open until COMMIT before failing. Independent review found
  -- the two writing paths had drifted apart on this.
  IF claimed <= clock_timestamp() THEN
    RAISE EXCEPTION 'trust_safety_activation_deadline_expired' USING ERRCODE = 'TS002';
  END IF;
  -- Fixed on the row, so the deferred check judges this instant's deadline and
  -- not whatever the setting holds at COMMIT. A caller cannot write the column
  -- itself: the assignment here overwrites whatever was supplied.
  NEW."deadlineAt" := claimed;
  RETURN NEW;
END $$;

CREATE TRIGGER trust_safety_observer_config_deadline_reach
    BEFORE INSERT OR UPDATE ON "TrustSafetyObserverConfig"
    FOR EACH ROW EXECUTE FUNCTION trust_safety_observer_config_deadline_reach();

CREATE FUNCTION trust_safety_observer_config_deadline_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Reads the row, never the setting. Re-reading it here would let the same
  -- transaction extend its own deadline after the reach check passed.
  IF clock_timestamp() > NEW."deadlineAt" THEN
    RAISE EXCEPTION 'trust_safety_activation_late_commit' USING ERRCODE = 'TS002';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trust_safety_observer_config_deadline_check
    AFTER INSERT OR UPDATE ON "TrustSafetyObserverConfig"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trust_safety_observer_config_deadline_check();

-- No delete path: §7's retention schedule is not approved, so the activation
-- history is not pruned here either. Turning the observer off is an UPDATE
-- with its own audit entry, never a delete.
CREATE FUNCTION trust_safety_observer_config_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'trust_safety_config_delete_refused' USING ERRCODE = 'TS007';
END $$;

CREATE TRIGGER trust_safety_observer_config_no_delete
    BEFORE DELETE ON "TrustSafetyObserverConfig"
    FOR EACH ROW EXECUTE FUNCTION trust_safety_observer_config_no_delete();
