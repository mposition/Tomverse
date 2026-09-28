-- A publisher run has a deadline, and a run that finished after it did not
-- succeed.
--
-- Authority: the S2 plan's "S2d1 -- Railway service and deadline that reaches
-- the work", and foundation r13 section 6.2a. Of everything S2d1 builds, this is
-- the part the plan calls mandatory and the part only the database can do:
-- "the one thing the database must enforce is that a late run is not recorded
-- as a success."
--
-- Why the database and not the route. The service is force-killed at its
-- deadline, but the route it called is not, and a COMMIT can still become
-- durable after the deadline -- on PostgreSQL 16 and 17 alike. So the route
-- cannot promise "nothing happened late"; it can only be prevented from saying
-- "this run succeeded" when it finished late. Individual idempotent writes may
-- already have committed; the run itself closes failed, never succeeded.
--
-- Scope. Only rows that carry a deadline. Every other scheduled job writes
-- `ScheduledJobRun` without one and is untouched by this trigger -- it returns
-- at once for them -- because their timing contract is a different one and
-- this slice has no authority over it.
--
-- The clock is the database's. The existing job helpers stamp `completedAt`
-- from the process's clock; for a row with a deadline the trigger overwrites
-- it, because a caller that could choose its own completion time could choose
-- one before its deadline.
--
-- Two refusals carry their own SQLSTATE, because the application branches on
-- them and a branch on message text breaks the day a driver rewords it:
--
--   TMDL1  a run that closed after its deadline asked to be `succeeded`
--   TMDL2  a run asked to start after its own deadline
--   TMDL3  a run asked to record a sign of life after its own deadline
--
-- A marketing publisher row with no deadline is refused outright, because
-- scoping the rest of this trigger to rows that have one made the absence a way
-- around all of it.
--
-- The rest are `check_violation`: they mean the caller is wrong, and nothing
-- is expected to catch them.

ALTER TABLE "ScheduledJobRun" ADD COLUMN "deadlineAt" TIMESTAMP(3);
ALTER TABLE "ScheduledJobRun" ADD COLUMN "heartbeatAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION "scheduled_job_run_deadline_guard"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    database_now TIMESTAMP(3);
BEGIN
    database_now := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);

    -- A deadline belongs to the insert that opened the run, and no update may
    -- add, move or remove one. Checked before the early return below, because
    -- clearing it would otherwise be the way out of every rule after it.
    --
    -- The first version of this only refused a change when the row already had
    -- a deadline, which left the invariant open by the widest door there is: a
    -- `succeeded` row with no deadline could be *given* one in the past, and
    -- because its status and completion time did not move, the closed-row
    -- branch below waved it through. The result was a succeeded run whose
    -- `completedAt` is after its `deadlineAt` -- exactly the row this trigger
    -- exists to make impossible.
    IF TG_OP = 'UPDATE'
        AND NEW."deadlineAt" IS DISTINCT FROM OLD."deadlineAt" THEN
        RAISE EXCEPTION 'ScheduledJobRun % deadline belongs to the insert that opened it', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    -- **A publisher run must carry a deadline.**
    --
    -- Scoping this trigger to rows that have one is what keeps it away from every
    -- other scheduled job, and it was also the way out of it. `startScheduledJob`
    -- accepts this job key -- it is a `RecordableScheduledJobKey` -- and writes no
    -- deadline, so a row created that way returned at the next line and
    -- `completeScheduledJob` could record `succeeded` an hour late. The one
    -- invariant the plan calls mandatory was bypassable through the canonical
    -- writer.
    --
    -- Nothing legitimate needs that row: the publisher opens its runs through
    -- `startMarketingPublisherRun`, which always supplies a deadline. So the
    -- absence is refused here, at the only place that can refuse it.
    IF TG_OP = 'INSERT'
        AND NEW."jobKey" = 'marketing_publisher'
        AND NEW."deadlineAt" IS NULL THEN
        RAISE EXCEPTION 'ScheduledJobRun % for the marketing publisher must carry a deadline', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."deadlineAt" IS NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        -- Starts running, on the database's clock, with a deadline still ahead.
        IF NEW."status" IS DISTINCT FROM 'running' THEN
            RAISE EXCEPTION 'ScheduledJobRun % with a deadline must start running', NEW."id"
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."startedAt" := database_now;
        NEW."heartbeatAt" := database_now;
        NEW."completedAt" := NULL;
        IF NEW."deadlineAt" <= database_now THEN
            RAISE EXCEPTION 'ScheduledJobRun % cannot start after its own deadline', NEW."id"
                USING ERRCODE = 'TMDL2';
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE from here on.

    -- A closed run stays closed. Otherwise a failed run could be flipped to
    -- succeeded afterwards, and the rule below would be a rule about the first
    -- write only.
    IF OLD."status" IS DISTINCT FROM 'running' THEN
        IF NEW."status" IS DISTINCT FROM OLD."status"
            OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt" THEN
            RAISE EXCEPTION 'ScheduledJobRun % is already closed as %', OLD."id", OLD."status"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    -- Still running: a heartbeat is the database's time, not the caller's,
    -- and a run past its deadline has no sign of life left to give.
    --
    -- Without the second rule the heartbeat became a way to hide the very thing
    -- the silence monitor watches for. The service is force-killed at the
    -- deadline but the app route it called is not, and that route kept beating:
    -- each beat moved `heartbeatAt` to the database's *current* time, so a run
    -- whose worker had been dead for an hour looked alive, and the incident
    -- that exists to notice it was deferred indefinitely.
    --
    -- Refused here rather than in the caller's predicate, because "is it past
    -- the deadline" is a question about the clock, and the caller's clock is
    -- not the one this column is stamped from.
    IF NEW."status" = 'running' THEN
        IF NEW."heartbeatAt" IS DISTINCT FROM OLD."heartbeatAt" THEN
            IF database_now > NEW."deadlineAt" THEN
                RAISE EXCEPTION 'ScheduledJobRun % cannot report a sign of life at % after its deadline %',
                    OLD."id", database_now, NEW."deadlineAt"
                    USING ERRCODE = 'TMDL3';
            END IF;
            NEW."heartbeatAt" := database_now;
        END IF;
        NEW."completedAt" := NULL;
        RETURN NEW;
    END IF;

    -- Closing. The completion time is the database's, and a run that closes
    -- after its deadline did not succeed.
    NEW."completedAt" := database_now;
    IF NEW."status" = 'succeeded' AND NEW."completedAt" > NEW."deadlineAt" THEN
        RAISE EXCEPTION 'ScheduledJobRun % finished at % after its deadline % and cannot be recorded as succeeded',
            OLD."id", NEW."completedAt", NEW."deadlineAt"
            USING ERRCODE = 'TMDL1';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "scheduled_job_run_deadline_guard"
    BEFORE INSERT OR UPDATE ON "ScheduledJobRun"
    FOR EACH ROW
    EXECUTE FUNCTION "scheduled_job_run_deadline_guard"();
