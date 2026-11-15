-- Owner decision 2026-11-15 ("내부 개발용 Flow입니다. 제한을 줄 이유가 없습니다.
-- 이런 제한을 다 찾아 없애 주세요."): the owner queues are counted, never
-- capped (docs/policy/engineering-agent.md §12). A full queue (8 pull requests
-- or 8 decisions, an active run counting in both) refused every new run, so
-- one slow review held every other card. This replaces the run guard's body
-- only: the attempt binding, the advisory lock, the mode and freeze checks and
-- every transition are unchanged; only the queue count and its refusal go. No
-- table, constraint or row changes.
-- baseline-check: replace-function-if-body-sha256 "engineering_agent_run_guard" "4b4cf795ddcbbb3f4bade6775b33c1861856e95434fec627e9609ad3722744d9" "e98e9c1f25a6f8c48394d74023e06626d5de201b787a3599a8bc76dc4919c734"
BEGIN;

CREATE OR REPLACE FUNCTION "engineering_agent_run_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    -- setting: ENGINEERING_AGENT_MODE_SETTING_KEY
    mode_key CONSTANT TEXT := 'feature.engineeringAgentMode';
    -- setting: ENGINEERING_AGENT_FREEZE_SETTING_KEY
    freeze_key CONSTANT TEXT := 'feature.engineeringAgentFreeze';
    attempt_matches BOOLEAN;
    mode_value TEXT;
    freeze_value TEXT;
BEGIN
    -- Ended runs are the circuit's input (§12): none is ever removed.
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'EngineeringAgentRun is kept' USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'active' THEN
            RAISE EXCEPTION 'EngineeringAgentRun starts active' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."leaseExpiresAt" <= now_utc THEN
            RAISE EXCEPTION 'EngineeringAgentRun lease is already over' USING ERRCODE = 'check_violation';
        END IF;
        -- The run is the attempt's, on the attempt's own card.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I."AmuxExecutionAttempt" a WHERE a."id" = $1 AND a."taskId" = $2)',
            TG_TABLE_SCHEMA
        ) INTO attempt_matches USING NEW."amuxAttemptId", NEW."cardId";
        IF NOT attempt_matches THEN
            RAISE EXCEPTION 'EngineeringAgentRun must bind an attempt to that attempt''s card'
                USING ERRCODE = 'check_violation';
        END IF;
        -- Runs are admitted one at a time, under the lock the owner queue
        -- was counted under; the queue itself is no longer capped here.
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('engineering-agent:owner-queue'));

        -- A run is a claim, and there is none while the mode is off or the
        -- agent is frozen (§12). The mode a run started under is read here,
        -- never taken from the caller; an unset or unknown value is `off`,
        -- as lib/engineeringAgentCore.ts reads it. A deferred check below
        -- holds that reading to the settings the transaction commits with.
        -- The environment kill switch is not in the database: the store reads
        -- it with these settings before every claim, capability and publish
        -- (lib/engineeringAgentStore.ts). The halt and the circuit are judged
        -- from observations the app makes before it claims.
        EXECUTE pg_catalog.format(
            'SELECT max(s."value") FILTER (WHERE s."key" = $1), max(s."value") FILTER (WHERE s."key" = $2)'
            ' FROM %I."AppSetting" s WHERE s."key" = ANY (ARRAY[$1, $2])',
            TG_TABLE_SCHEMA
        ) INTO mode_value, freeze_value USING mode_key, freeze_key;
        NEW."modeAtStart" := CASE WHEN mode_value IN ('shadow', 't1') THEN mode_value ELSE 'off' END;
        IF NEW."modeAtStart" = 'off' THEN
            RAISE EXCEPTION 'EngineeringAgentRun refused: the mode is off' USING ERRCODE = 'check_violation';
        END IF;
        IF freeze_value = 'true' THEN
            RAISE EXCEPTION 'EngineeringAgentRun refused: the agent is frozen' USING ERRCODE = 'check_violation';
        END IF;

        -- The owner queues (§12) are counted, never capped (owner decision
        -- 2026-11-15): a full queue stopped every new claim, so one slow
        -- review held every other card. The app shows their length, and with
        -- ENGINEERING_AGENT_LEGACY_HALTS holds the old caps itself.
        -- The daily run cap (§12) waits for its number (§16); none is made
        -- up here.
        NEW."startedAt" := now_utc;
        RETURN NEW;
    END IF;

    IF OLD."status" <> 'active' THEN
        RAISE EXCEPTION 'EngineeringAgentRun % has ended and is immutable', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."amuxAttemptId" IS DISTINCT FROM OLD."amuxAttemptId"
        OR NEW."cardId" IS DISTINCT FROM OLD."cardId"
        OR NEW."cardKind" IS DISTINCT FROM OLD."cardKind"
        OR NEW."baseSha" IS DISTINCT FROM OLD."baseSha"
        OR NEW."modeAtStart" IS DISTINCT FROM OLD."modeAtStart"
        OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
        RAISE EXCEPTION 'EngineeringAgentRun % cannot change what it is bound to', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
        IF (OLD."status", NEW."status") NOT IN (
            -- transitions: EngineeringAgentRun run
            ('active', 'finished'),
            ('active', 'abandoned')
            -- end transitions
        ) THEN
            RAISE EXCEPTION 'EngineeringAgentRun % cannot go from % to %', OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'check_violation';
        END IF;
        -- A run that outlived its lease is not recorded as a success.
        IF NEW."status" = 'finished' AND OLD."leaseExpiresAt" <= now_utc THEN
            RAISE EXCEPTION 'EngineeringAgentRun % finished after its lease', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."endedAt" := now_utc;
        NEW."leaseExpiresAt" := OLD."leaseExpiresAt";
    ELSIF NEW."leaseExpiresAt" IS DISTINCT FROM OLD."leaseExpiresAt" THEN
        -- A heartbeat extends a live lease; a lease that has run out stays out.
        IF OLD."leaseExpiresAt" <= now_utc OR NEW."leaseExpiresAt" <= OLD."leaseExpiresAt" THEN
            RAISE EXCEPTION 'EngineeringAgentRun % lease cannot move that way', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF NEW."endedAt" IS DISTINCT FROM OLD."endedAt" AND NEW."status" = OLD."status" THEN
        RAISE EXCEPTION 'EngineeringAgentRun endedAt is written by the database' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
