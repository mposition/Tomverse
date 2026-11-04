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
