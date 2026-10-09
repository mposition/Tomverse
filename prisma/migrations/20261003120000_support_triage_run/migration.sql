-- Support-triage run record (docs/policy/support-triage.md §4, §8).
--
-- One row per worker or retention run. Content-free: kind, outcome, times and
-- counters, no report text and no identifier of a report or a person. This
-- migration writes no row and turns nothing on.
--
-- What the database enforces here, so the application cannot get it wrong:
--
--   * the run's deadline is the database's clock plus the kind's budget
--     (worker 5 minutes, retention 100 seconds); a caller cannot claim one;
--   * at most 52 runs per kind per UTC day, serialised by a transaction
--     advisory lock so two concurrent inserts at 51 cannot both pass;
--   * a run that finishes after its deadline is recorded as
--     `deadline_exceeded`, never `success` or `partial`;
--   * kind, deadline, creation time and a finished outcome never change;
--   * a row younger than 30 days cannot be deleted.
--
-- Time is the database's: every timestamp a trigger writes or compares is
-- clock_timestamp() AT TIME ZONE 'UTC', read once per trigger call.
-- Every trigger function pins search_path to pg_catalog, pg_temp and reads
-- its own table through TG_TABLE_SCHEMA. None has an EXCEPTION handler.

BEGIN;

CREATE TABLE "SupportTriageRun" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'running',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "batchesCompleted" INTEGER,
    "overdueRemaining" INTEGER,
    "oldestOverdueAgeSeconds" INTEGER,
    "blocked" INTEGER,

    CONSTRAINT "SupportTriageRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportTriageRun_sequence_key" ON "SupportTriageRun"("sequence");

CREATE INDEX "SupportTriageRun_kind_createdAt_idx" ON "SupportTriageRun"("kind", "createdAt");

ALTER TABLE "SupportTriageRun"
    ADD CONSTRAINT "SupportTriageRun_kind_check"
        CHECK ("kind" IN ('worker', 'retention')),
    ADD CONSTRAINT "SupportTriageRun_outcome_check"
        CHECK ("outcome" IN ('running', 'success', 'partial', 'failed', 'deadline_exceeded')),
    -- A running row has not finished; every other outcome has.
    ADD CONSTRAINT "SupportTriageRun_finished_check"
        CHECK (("outcome" = 'running') = ("finishedAt" IS NULL)),
    -- NULL-safe: success and partial need both times present and in order.
    ADD CONSTRAINT "SupportTriageRun_success_in_time_check"
        CHECK ("outcome" NOT IN ('success', 'partial')
               OR ("finishedAt" IS NOT NULL AND "finishedAt" <= "deadlineAt")),
    -- A witness, not a preventer: the batch counter in the application stops
    -- the ninth batch; this refuses the finished row if it ever did not.
    ADD CONSTRAINT "SupportTriageRun_retention_batches_check"
        CHECK ("kind" <> 'retention' OR "batchesCompleted" IS NULL OR "batchesCompleted" <= 8),
    ADD CONSTRAINT "SupportTriageRun_counters_check"
        CHECK (("batchesCompleted" IS NULL OR "batchesCompleted" >= 0)
               AND ("overdueRemaining" IS NULL OR "overdueRemaining" >= 0)
               AND ("oldestOverdueAgeSeconds" IS NULL OR "oldestOverdueAgeSeconds" >= 0)
               AND ("blocked" IS NULL OR "blocked" >= 0));

-- ---------------------------------------------------------------------------
-- BEFORE INSERT: creation time, deadline and the daily cap, all from one
-- clock read so a run cannot be counted on one UTC day and dated on another.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "support_triage_run_before_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    -- limit: DAILY_RUN_CAP
    daily_cap CONSTANT INTEGER := 52;
    day_start TIMESTAMP(3);
    runs_today BIGINT;
BEGIN
    IF NEW."outcome" <> 'running' OR NEW."finishedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'SupportTriageRun must be inserted as running'
            USING ERRCODE = 'check_violation';
    END IF;

    NEW."createdAt" := now_utc;
    -- limit: LANE_TIMEOUTS.worker.deadlineMs, LANE_TIMEOUTS.retention.deadlineMs
    NEW."deadlineAt" := now_utc + CASE NEW."kind"
        WHEN 'worker' THEN interval '5 minutes'
        WHEN 'retention' THEN interval '100 seconds'
    END;

    day_start := date_trunc('day', now_utc);
    PERFORM pg_advisory_xact_lock(
        hashtext('support_triage_run_daily_cap:' || NEW."kind" || ':'
                 || to_char(day_start, 'YYYY-MM-DD'))
    );
    EXECUTE pg_catalog.format(
        'SELECT count(*) FROM %I."SupportTriageRun" r'
        ' WHERE r."kind" = $1 AND r."createdAt" >= $2 AND r."createdAt" < $3',
        TG_TABLE_SCHEMA
    ) INTO runs_today USING NEW."kind", day_start, day_start + interval '1 day';

    IF runs_today >= daily_cap THEN
        RAISE EXCEPTION 'support_triage_run_daily_cap_exceeded'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SupportTriageRun_before_insert"
    BEFORE INSERT ON "SupportTriageRun"
    FOR EACH ROW EXECUTE FUNCTION "support_triage_run_before_insert"();

-- ---------------------------------------------------------------------------
-- BEFORE UPDATE: identity and deadline are immutable, a finished row is
-- final, and finishing stamps the database's time and downgrades a late
-- success. The one thing the database must enforce is that a late run is not
-- recorded as a success.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "support_triage_run_before_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
        OR NEW."kind" IS DISTINCT FROM OLD."kind"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
        OR NEW."deadlineAt" IS DISTINCT FROM OLD."deadlineAt" THEN
        RAISE EXCEPTION 'SupportTriageRun identity, creation time and deadline are immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."outcome" <> 'running' THEN
        RAISE EXCEPTION 'SupportTriageRun % is already finished', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."outcome" <> 'running' THEN
        NEW."finishedAt" := now_utc;
        IF NEW."outcome" IN ('success', 'partial') AND now_utc > OLD."deadlineAt" THEN
            NEW."outcome" := 'deadline_exceeded';
        END IF;
    ELSE
        NEW."finishedAt" := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SupportTriageRun_before_update"
    BEFORE UPDATE ON "SupportTriageRun"
    FOR EACH ROW EXECUTE FUNCTION "support_triage_run_before_update"();

-- ---------------------------------------------------------------------------
-- BEFORE DELETE: only rows past the 30-day retention boundary. The predicate
-- is the negation of the retention step's delete condition, `<=` on both
-- sides, so the row at the boundary is deletable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "support_triage_run_before_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    -- limit: SUPPORT_TRIAGE_RUN_RETENTION_DAYS
    IF NOT (OLD."createdAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 days') THEN
        RAISE EXCEPTION 'SupportTriageRun % is inside its 30-day retention window', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER "SupportTriageRun_before_delete"
    BEFORE DELETE ON "SupportTriageRun"
    FOR EACH ROW EXECUTE FUNCTION "support_triage_run_before_delete"();

COMMIT;
