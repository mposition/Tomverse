-- Owner decision 2026-11-09: the owner queues hold 8 pull requests and 8
-- decisions, and the first T1 window that held the pull request queue to 1
-- for 14 days is removed (docs/policy/engineering-agent.md §12). v22 cards
-- were refused at publish with `run_admission_owner_queue_full` while two
-- slots were taken. This replaces the run guard's body only: the queue
-- counts, the advisory lock, the mode and freeze checks and every transition
-- are unchanged; only the two caps change and the window is gone. No table,
-- constraint or row changes.
-- baseline-check: replace-function-if-body-sha256 "engineering_agent_run_guard" "6f6bf1fbe191f6fc3089129f88246d3b211e6ed80e36798deff21407ba8fdf43" "4b4cf795ddcbbb3f4bade6775b33c1861856e95434fec627e9609ad3722744d9"
BEGIN;

CREATE OR REPLACE FUNCTION "engineering_agent_run_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    -- limit: OWNER_QUEUE_LIMITS.pr
    pr_limit CONSTANT INTEGER := 8;
    -- limit: OWNER_QUEUE_LIMITS.decision
    decision_limit CONSTANT INTEGER := 8;
    -- setting: ENGINEERING_AGENT_MODE_SETTING_KEY
    mode_key CONSTANT TEXT := 'feature.engineeringAgentMode';
    -- setting: ENGINEERING_AGENT_FREEZE_SETTING_KEY
    freeze_key CONSTANT TEXT := 'feature.engineeringAgentFreeze';
    attempt_matches BOOLEAN;
    mode_value TEXT;
    freeze_value TEXT;
    open_prs BIGINT;
    pending_decisions BIGINT;
    active_runs BIGINT;
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
        -- Runs are admitted one at a time.
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

        -- The owner queues (§12), counted in one statement so that a change
        -- committing in between is seen once, not in neither count. What a
        -- run can become is counted before it exists: an active run may
        -- still produce a pull request or a decision, and a publish item not
        -- yet settled may still produce a binding. Every binding and every
        -- draft comes from an admitted run, so refusing the run is the cap.
        -- Decision items opened for a mismatch, an unknown outcome or a
        -- partial registration are counted and never refused: recording a
        -- problem is not a claim.
        EXECUTE pg_catalog.format(
            'SELECT'
            ' (SELECT count(*) FROM %1$I."EngineeringAgentBinding" b WHERE b."state" = ANY ($1) AND b."supersededAt" IS NULL)'
            ' + (SELECT count(*) FROM %1$I."EngineeringAgentWorkItem" w WHERE w."kind" = $2 AND w."state" = ANY ($3)),'
            ' (SELECT count(*) FROM %1$I."EngineeringAgentWorkItem" w WHERE w."kind" = ANY ($4) AND w."state" = $5),'
            ' (SELECT count(*) FROM %1$I."EngineeringAgentRun" r WHERE r."status" = $6)',
            TG_TABLE_SCHEMA
        ) INTO open_prs, pending_decisions, active_runs
        USING ARRAY['open', 'closed'], 'publish', ARRAY['queued', 'claimed', 'needs_lookup', 'outcome_unknown'],
              ARRAY['t2_draft', 'decision', 'state_mismatch'], 'open', 'active';

        IF open_prs + active_runs >= pr_limit OR pending_decisions + active_runs >= decision_limit THEN
            RAISE EXCEPTION 'EngineeringAgentRun refused: the owner queue is full' USING ERRCODE = 'check_violation';
        END IF;
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
