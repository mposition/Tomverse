-- The sre-ops run guard (docs/policy/sre-ops.md §3 rule 8, §6 items 2-5, §10).
--
-- The daily digest's write lands in shared tables (AgentDigestItem,
-- AdminAuditLog), which carry no column or trigger of this agent's. So the
-- digest transaction also inserts one row here, as its last write, and this
-- table's deferred constraint trigger refuses the COMMIT once the database
-- clock is past the run's deadline: a late digest rolls back whole, the
-- shared rows included. What the database owns:
--
--   1. A row is born with the database clock as its start, a deadline no
--      more than 180 s ahead (the claim every ops-observer row passes) and
--      the run id of its owner date, `sre-ops:daily:YYYY-MM-DD`.
--   2. Rows never change. A row is deleted only 90 days after its start.
--   3. The deadline is checked again at COMMIT (OB012), deferred, like the
--      other own tables'.
--
-- One row per owner date at most, so the table holds a few hundred rows over
-- its retention. Nothing is written and nothing is turned on.

BEGIN;

CREATE TABLE "OpsObserverRunGuard" (
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runDeadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "invariantVersion" INTEGER NOT NULL,

    CONSTRAINT "OpsObserverRunGuard_pkey" PRIMARY KEY ("runId")
);

ALTER TABLE "OpsObserverRunGuard"
    -- kinds: OPS_OBSERVER_RUN_GUARD_KINDS
    ADD CONSTRAINT "OpsObserverRunGuard_kind_check" CHECK ("kind" IN ('daily_digest')),
    ADD CONSTRAINT "OpsObserverRunGuard_runId_check"
        CHECK ("kind" <> 'daily_digest' OR "runId" ~ '^sre-ops:daily:[0-9]{4}-[0-9]{2}-[0-9]{2}$');

CREATE FUNCTION ops_observer_run_guard_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."startedAt" > clock_timestamp() - interval '90 days' THEN
      RAISE EXCEPTION 'ops_observer_run_guard_retained' USING ERRCODE = 'OB080';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ops_observer_run_guard_immutable' USING ERRCODE = 'OB081';
  END IF;
  EXECUTE format('SELECT %I.ops_observer_deadline_claim($1)', TG_TABLE_SCHEMA) USING NEW."runDeadlineAt";
  NEW."startedAt" := clock_timestamp();
  NEW."invariantVersion" := 1;
  RETURN NEW;
END $$;

CREATE FUNCTION ops_observer_run_guard_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'ops_observer_run_guard_retained' USING ERRCODE = 'OB080';
END $$;

CREATE TRIGGER "OpsObserverRunGuard_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "OpsObserverRunGuard"
    FOR EACH ROW EXECUTE FUNCTION ops_observer_run_guard_guard();

CREATE TRIGGER "OpsObserverRunGuard_no_truncate"
    BEFORE TRUNCATE ON "OpsObserverRunGuard"
    FOR EACH STATEMENT EXECUTE FUNCTION ops_observer_run_guard_no_truncate();

CREATE CONSTRAINT TRIGGER ops_observer_run_guard_deadline_check
    AFTER INSERT ON "OpsObserverRunGuard"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ops_observer_deadline_check();

COMMIT;
