-- Engineering agent state (docs/policy/engineering-agent.md §11).
--
-- Seven tables, no user content, one writer (lib/engineeringAgentStore.ts,
-- enforced by scripts/check-protected-table-writers-core.mjs). This migration
-- writes no row and turns nothing on: the agent's mode is read from AppSetting
-- and an unset mode is `off`.
--
-- Every status column has a transition trigger. The allowed transitions are
-- written below as `-- transitions: <table> <kind>` blocks of VALUES, one pair
-- per line, and tests/engineeringAgentSchema.test.mjs checks each block
-- against the table in lib/engineeringAgentCore.ts that owns it, so the two
-- cannot drift.
--
-- Time is the database's: every timestamp a trigger writes, and every lease a
-- trigger compares, is clock_timestamp() AT TIME ZONE 'UTC'. The one thing the
-- database must enforce is that a late run is not recorded as a success
-- (§11, "본 앱의 시간 상한"): a success transition out of a lease is refused
-- once that lease has passed.
--
-- Every trigger function pins search_path to pg_catalog, pg_temp and reads
-- its sibling tables through TG_TABLE_SCHEMA, so a session's temporary table
-- of the same name cannot stand in for the real one.

BEGIN;

-- ---------------------------------------------------------------------------
-- EngineeringAgentRun: one AMUX execution attempt, 1:1. A run records the
-- mode it started under; the first T1 window's shorter PR limit is read from
-- the earliest run that started under `t1` (§12).
-- ---------------------------------------------------------------------------

CREATE TABLE "EngineeringAgentRun" (
    "id" TEXT NOT NULL,
    "amuxAttemptId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "cardKind" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "outcome" TEXT,
    "halt" TEXT NOT NULL DEFAULT 'none',
    "modeAtStart" TEXT NOT NULL DEFAULT 'off',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "EngineeringAgentRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EngineeringAgentRun"
    ADD CONSTRAINT "EngineeringAgentRun_amuxAttemptId_key" UNIQUE ("amuxAttemptId"),
    ADD CONSTRAINT "EngineeringAgentRun_id_check" CHECK ("id" ~ '^[0-9]{1,12}$'),
    ADD CONSTRAINT "EngineeringAgentRun_baseSha_check" CHECK ("baseSha" ~ '^[0-9a-f]{40}$'),
    ADD CONSTRAINT "EngineeringAgentRun_cardKind_check" CHECK ("cardKind" ~ '^[a-z_]{1,40}$'),
    ADD CONSTRAINT "EngineeringAgentRun_status_check"
        CHECK ("status" IN ('active', 'finished', 'abandoned')),
    ADD CONSTRAINT "EngineeringAgentRun_outcome_check"
        CHECK ("outcome" IS NULL OR "outcome" IN (
            't1_queued', 't2_draft', 'no_change', 'agent_failed', 'schema_invalid',
            'scope_violation', 'secret_detected', 'abandoned'
        )),
    ADD CONSTRAINT "EngineeringAgentRun_modeAtStart_check"
        CHECK ("modeAtStart" IN ('off', 'shadow', 't1')),
    ADD CONSTRAINT "EngineeringAgentRun_halt_check"
        CHECK ("halt" IN (
            'none', 'config_missing', 'circuit_open', 'unbound_app_pr', 'unbound_app_ref', 'state_mismatch'
        )),
    -- An active run has no outcome and no end; a finished run has an outcome
    -- other than `abandoned`; an abandoned run has exactly that outcome.
    ADD CONSTRAINT "EngineeringAgentRun_status_outcome_check"
        CHECK (
            ("status" = 'active' AND "outcome" IS NULL AND "endedAt" IS NULL)
            OR ("status" = 'finished' AND "outcome" IS NOT NULL AND "outcome" <> 'abandoned' AND "endedAt" IS NOT NULL)
            OR ("status" = 'abandoned' AND "outcome" = 'abandoned' AND "endedAt" IS NOT NULL)
        );

CREATE INDEX "EngineeringAgentRun_status_leaseExpiresAt_idx"
    ON "EngineeringAgentRun"("status", "leaseExpiresAt");
CREATE INDEX "EngineeringAgentRun_endedAt_idx" ON "EngineeringAgentRun"("endedAt");
CREATE INDEX "EngineeringAgentRun_modeAtStart_startedAt_idx"
    ON "EngineeringAgentRun"("modeAtStart", "startedAt");

ALTER TABLE "EngineeringAgentRun"
    ADD CONSTRAINT "EngineeringAgentRun_amuxAttemptId_fkey"
        FOREIGN KEY ("amuxAttemptId") REFERENCES "AmuxExecutionAttempt"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "EngineeringAgentRun_cardId_fkey"
        FOREIGN KEY ("cardId") REFERENCES "AmuxWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "engineering_agent_run_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    -- limit: OWNER_QUEUE_LIMITS.pr
    pr_limit CONSTANT INTEGER := 2;
    -- limit: OWNER_QUEUE_LIMITS.prDuringFirstT1Days
    first_t1_pr_limit CONSTANT INTEGER := 1;
    -- limit: FIRST_T1_WINDOW_DAYS
    first_t1_days CONSTANT INTEGER := 14;
    -- limit: OWNER_QUEUE_LIMITS.decision
    decision_limit CONSTANT INTEGER := 3;
    -- setting: ENGINEERING_AGENT_MODE_SETTING_KEY
    mode_key CONSTANT TEXT := 'feature.engineeringAgentMode';
    -- setting: ENGINEERING_AGENT_FREEZE_SETTING_KEY
    freeze_key CONSTANT TEXT := 'feature.engineeringAgentFreeze';
    effective_pr_limit INTEGER;
    attempt_matches BOOLEAN;
    mode_value TEXT;
    freeze_value TEXT;
    t1_started TIMESTAMP(3);
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
        -- The environment kill switch is not in the database: the app reads
        -- it, with the halt and the circuit, before it claims.
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
            ' (SELECT count(*) FROM %1$I."EngineeringAgentRun" r WHERE r."status" = $6),'
            ' (SELECT min(r."startedAt") FROM %1$I."EngineeringAgentRun" r WHERE r."modeAtStart" = $7)',
            TG_TABLE_SCHEMA
        ) INTO open_prs, pending_decisions, active_runs, t1_started
        USING ARRAY['open', 'closed'], 'publish', ARRAY['queued', 'claimed', 'needs_lookup', 'outcome_unknown'],
              ARRAY['t2_draft', 'decision', 'state_mismatch'], 'open', 'active', 't1';

        -- The first T1 window starts with the first run in this database
        -- that started under `t1`: never earlier than the mode change, so the
        -- window is never shorter than the policy's. Runs are never deleted,
        -- so the start never moves; a later return to `t1` after `off` opens
        -- no second window, because §12 names only the first.
        IF t1_started IS NULL AND NEW."modeAtStart" = 't1' THEN
            t1_started := now_utc;
        END IF;
        effective_pr_limit := CASE
            WHEN t1_started IS NOT NULL AND now_utc < t1_started + first_t1_days * INTERVAL '1 day'
                THEN first_t1_pr_limit
            ELSE pr_limit
        END;
        IF open_prs + active_runs >= effective_pr_limit OR pending_decisions + active_runs >= decision_limit THEN
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

CREATE TRIGGER "engineering_agent_run_guard_insert"
    BEFORE INSERT ON "EngineeringAgentRun"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_run_guard"();
CREATE TRIGGER "engineering_agent_run_guard_update"
    BEFORE UPDATE ON "EngineeringAgentRun"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_run_guard"();
CREATE TRIGGER "engineering_agent_run_guard_delete"
    BEFORE DELETE ON "EngineeringAgentRun"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_run_guard"();

-- The mode a run records is the mode the transaction commits with. Setting
-- `t1`, starting a run and setting it back inside one transaction would
-- otherwise record a run under a mode that was never in force, and open the
-- first T1 window without a committed mode change.
CREATE OR REPLACE FUNCTION "engineering_agent_run_mode_committed"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    -- setting: ENGINEERING_AGENT_MODE_SETTING_KEY
    mode_key CONSTANT TEXT := 'feature.engineeringAgentMode';
    -- setting: ENGINEERING_AGENT_FREEZE_SETTING_KEY
    freeze_key CONSTANT TEXT := 'feature.engineeringAgentFreeze';
    mode_value TEXT;
    freeze_value TEXT;
BEGIN
    EXECUTE pg_catalog.format(
        'SELECT max(s."value") FILTER (WHERE s."key" = $1), max(s."value") FILTER (WHERE s."key" = $2)'
        ' FROM %I."AppSetting" s WHERE s."key" = ANY (ARRAY[$1, $2])',
        TG_TABLE_SCHEMA
    ) INTO mode_value, freeze_value USING mode_key, freeze_key;
    IF (CASE WHEN mode_value IN ('shadow', 't1') THEN mode_value ELSE 'off' END) <> NEW."modeAtStart"
        OR freeze_value = 'true' THEN
        RAISE EXCEPTION 'EngineeringAgentRun % started under a mode the transaction does not commit with', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "engineering_agent_run_mode_committed"
    AFTER INSERT ON "EngineeringAgentRun"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_run_mode_committed"();

-- ---------------------------------------------------------------------------
-- EngineeringAgentWorkItem: T2 drafts, the three GitHub writes, decisions and
-- state mismatches.
-- ---------------------------------------------------------------------------

CREATE TABLE "EngineeringAgentWorkItem" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "causeKey" TEXT NOT NULL,
    "runId" TEXT,
    "patchBody" TEXT,
    "patchDigest" TEXT,
    "baseSha" TEXT,
    "expectedTreeId" TEXT,
    "reason" TEXT,
    "claimMode" TEXT,
    "fencingToken" BIGINT NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "EngineeringAgentWorkItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EngineeringAgentWorkItem"
    ADD CONSTRAINT "EngineeringAgentWorkItem_causeKey_key" UNIQUE ("causeKey"),
    ADD CONSTRAINT "EngineeringAgentWorkItem_id_check" CHECK ("id" ~ '^[A-Za-z0-9_-]{1,64}$'),
    ADD CONSTRAINT "EngineeringAgentWorkItem_kind_check"
        CHECK ("kind" IN ('t2_draft', 'publish', 'expire_close', 'prune', 'decision', 'state_mismatch')),
    ADD CONSTRAINT "EngineeringAgentWorkItem_state_check"
        CHECK (
            ("kind" = 'publish' AND "state" IN (
                'queued', 'claimed', 'needs_lookup', 'outcome_unknown', 'expired',
                'published', 'publish_refused', 'publish_failed'))
            OR ("kind" = 'expire_close' AND "state" IN (
                'queued', 'claimed', 'needs_lookup', 'outcome_unknown',
                'closed', 'expire_refused', 'expire_failed'))
            OR ("kind" = 'prune' AND "state" IN (
                'queued', 'claimed', 'needs_lookup', 'outcome_unknown',
                'pruned', 'prune_refused', 'prune_failed'))
            OR ("kind" = 't2_draft' AND "state" IN ('open', 'approved', 'rejected', 'expired'))
            OR ("kind" = 'decision' AND "state" IN ('open', 'acknowledged', 'expired'))
            OR ("kind" = 'state_mismatch' AND "state" IN ('open', 'resolved'))
        ),
    ADD CONSTRAINT "EngineeringAgentWorkItem_causeKey_check" CHECK ("causeKey" ~ '^[a-z0-9_]{1,20}:[!-~]{1,200}$'),
    ADD CONSTRAINT "EngineeringAgentWorkItem_patchBody_check"
        CHECK ("patchBody" IS NULL OR octet_length("patchBody") <= 65536),
    ADD CONSTRAINT "EngineeringAgentWorkItem_patchDigest_check"
        CHECK ("patchDigest" IS NULL OR "patchDigest" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "EngineeringAgentWorkItem_baseSha_check"
        CHECK ("baseSha" IS NULL OR "baseSha" ~ '^[0-9a-f]{40}$'),
    ADD CONSTRAINT "EngineeringAgentWorkItem_expectedTreeId_check"
        CHECK ("expectedTreeId" IS NULL OR "expectedTreeId" ~ '^[0-9a-f]{40}$'),
    -- The reason is an enum-shaped code, never free text.
    ADD CONSTRAINT "EngineeringAgentWorkItem_reason_check"
        CHECK ("reason" IS NULL OR "reason" ~ '^[a-z_]{1,64}$'),
    ADD CONSTRAINT "EngineeringAgentWorkItem_claimMode_check"
        CHECK ("claimMode" IS NULL OR "claimMode" IN ('write', 'lookup')),
    -- A draft and a publish item carry their patch: the owner reads a draft's,
    -- and the publisher applies a publish item's (§11: the app stores the
    -- patch and never applies it). The body is the text its digest names.
    -- No other kind carries one.
    ADD CONSTRAINT "EngineeringAgentWorkItem_payload_check"
        CHECK (
            ("kind" IN ('t2_draft', 'publish')
                AND "patchBody" IS NOT NULL AND "patchDigest" IS NOT NULL AND "baseSha" IS NOT NULL
                AND encode(sha256(convert_to("patchBody", 'UTF8')), 'hex') = "patchDigest")
            OR ("kind" NOT IN ('t2_draft', 'publish') AND "patchDigest" IS NULL AND "patchBody" IS NULL)
        ),
    ADD CONSTRAINT "EngineeringAgentWorkItem_publish_tree_check"
        CHECK ("kind" <> 'publish' OR "expectedTreeId" IS NOT NULL),
    ADD CONSTRAINT "EngineeringAgentWorkItem_claim_check"
        CHECK (("state" = 'claimed') = ("claimMode" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL));

CREATE INDEX "EngineeringAgentWorkItem_kind_state_idx" ON "EngineeringAgentWorkItem"("kind", "state");
CREATE INDEX "EngineeringAgentWorkItem_runId_idx" ON "EngineeringAgentWorkItem"("runId");
CREATE INDEX "EngineeringAgentWorkItem_state_leaseExpiresAt_idx"
    ON "EngineeringAgentWorkItem"("state", "leaseExpiresAt");

ALTER TABLE "EngineeringAgentWorkItem"
    ADD CONSTRAINT "EngineeringAgentWorkItem_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "EngineeringAgentRun"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "engineering_agent_work_item_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    terminal BOOLEAN;
    consumed_token BIGINT;
    decided BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT (
            (NEW."kind" IN ('publish', 'expire_close', 'prune') AND NEW."state" = 'queued')
            OR (NEW."kind" IN ('t2_draft', 'decision', 'state_mismatch') AND NEW."state" = 'open')
        ) THEN
            RAISE EXCEPTION 'EngineeringAgentWorkItem starts queued or open' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."fencingToken" <> 0 OR NEW."claimMode" IS NOT NULL OR NEW."closedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'EngineeringAgentWorkItem starts unclaimed' USING ERRCODE = 'check_violation';
        END IF;
        NEW."createdAt" := now_utc;
        NEW."updatedAt" := now_utc;
        RETURN NEW;
    END IF;

    terminal := OLD."state" NOT IN ('queued', 'claimed', 'needs_lookup', 'outcome_unknown', 'open');

    IF TG_OP = 'DELETE' THEN
        IF NOT terminal THEN
            RAISE EXCEPTION 'an open EngineeringAgentWorkItem cannot be deleted' USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."kind" IS DISTINCT FROM OLD."kind"
        OR NEW."causeKey" IS DISTINCT FROM OLD."causeKey"
        OR NEW."runId" IS DISTINCT FROM OLD."runId"
        OR NEW."patchDigest" IS DISTINCT FROM OLD."patchDigest"
        OR NEW."baseSha" IS DISTINCT FROM OLD."baseSha"
        OR NEW."expectedTreeId" IS DISTINCT FROM OLD."expectedTreeId"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'EngineeringAgentWorkItem % cannot change what it is about', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    -- A patch body never arrives, changes or leaves here. Its removal after a
    -- retention period is for a later migration, once the policy fixes that
    -- period (§16); until then the draft is the only copy and stays whole.
    IF NEW."patchBody" IS DISTINCT FROM OLD."patchBody" THEN
        RAISE EXCEPTION 'EngineeringAgentWorkItem % patch body is kept until a retention period is fixed', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF terminal THEN
        IF NEW."state" IS DISTINCT FROM OLD."state"
            OR NEW."reason" IS DISTINCT FROM OLD."reason"
            OR NEW."claimMode" IS DISTINCT FROM OLD."claimMode"
            OR NEW."fencingToken" IS DISTINCT FROM OLD."fencingToken"
            OR NEW."leaseExpiresAt" IS DISTINCT FROM OLD."leaseExpiresAt"
            OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt" THEN
            RAISE EXCEPTION 'EngineeringAgentWorkItem % is closed', OLD."id" USING ERRCODE = 'check_violation';
        END IF;
        NEW."updatedAt" := now_utc;
        RETURN NEW;
    END IF;

    IF NEW."state" IS DISTINCT FROM OLD."state" THEN
        IF NOT (
            (OLD."kind" = 'publish' AND (OLD."state", NEW."state") IN (
                -- transitions: EngineeringAgentWorkItem publish
                ('queued', 'claimed'),
                ('claimed', 'published'),
                ('claimed', 'queued'),
                ('claimed', 'publish_refused'),
                ('claimed', 'publish_failed'),
                ('claimed', 'needs_lookup'),
                ('claimed', 'outcome_unknown'),
                ('needs_lookup', 'claimed'),
                ('outcome_unknown', 'claimed'),
                ('queued', 'expired')
                -- end transitions
            ))
            OR (OLD."kind" = 'expire_close' AND (OLD."state", NEW."state") IN (
                -- transitions: EngineeringAgentWorkItem expire_close
                ('queued', 'claimed'),
                ('claimed', 'closed'),
                ('claimed', 'queued'),
                ('claimed', 'expire_refused'),
                ('claimed', 'expire_failed'),
                ('claimed', 'needs_lookup'),
                ('claimed', 'outcome_unknown'),
                ('needs_lookup', 'claimed'),
                ('outcome_unknown', 'claimed')
                -- end transitions
            ))
            OR (OLD."kind" = 'prune' AND (OLD."state", NEW."state") IN (
                -- transitions: EngineeringAgentWorkItem prune
                ('queued', 'claimed'),
                ('claimed', 'pruned'),
                ('claimed', 'queued'),
                ('claimed', 'prune_refused'),
                ('claimed', 'prune_failed'),
                ('claimed', 'needs_lookup'),
                ('claimed', 'outcome_unknown'),
                ('needs_lookup', 'claimed'),
                ('outcome_unknown', 'claimed')
                -- end transitions
            ))
            OR (OLD."kind" = 't2_draft' AND (OLD."state", NEW."state") IN (
                -- transitions: EngineeringAgentWorkItem t2_draft
                ('open', 'approved'),
                ('open', 'rejected'),
                ('open', 'expired')
                -- end transitions
            ))
            OR (OLD."kind" = 'decision' AND (OLD."state", NEW."state") IN (
                -- transitions: EngineeringAgentWorkItem decision
                ('open', 'acknowledged'),
                ('open', 'expired')
                -- end transitions
            ))
            OR (OLD."kind" = 'state_mismatch' AND (OLD."state", NEW."state") IN (
                -- transitions: EngineeringAgentWorkItem state_mismatch
                ('open', 'resolved')
                -- end transitions
            ))
        ) THEN
            RAISE EXCEPTION 'EngineeringAgentWorkItem % (%) cannot go from % to %',
                OLD."id", OLD."kind", OLD."state", NEW."state"
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW."state" = 'claimed' THEN
            -- Every claim takes the next fencing token and a live lease. A write
            -- claim starts only from `queued`; a lookup claim only from the two
            -- states that exist to be looked up.
            IF NEW."fencingToken" <> OLD."fencingToken" + 1
                OR NEW."leaseExpiresAt" IS NULL OR NEW."leaseExpiresAt" <= now_utc
                OR (NEW."claimMode" = 'write' AND OLD."state" <> 'queued')
                OR (NEW."claimMode" = 'lookup' AND OLD."state" NOT IN ('needs_lookup', 'outcome_unknown')) THEN
                RAISE EXCEPTION 'EngineeringAgentWorkItem % claim is not well formed', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        ELSE
            IF NEW."fencingToken" <> OLD."fencingToken" THEN
                RAISE EXCEPTION 'EngineeringAgentWorkItem % fencing token only moves on a claim', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
            -- Once a claim's lease has passed, the only way out is a lookup:
            -- no result, success or failure, and no return to the queue is
            -- recorded without finding out what the earlier claim did (§10).
            IF OLD."state" = 'claimed' AND OLD."leaseExpiresAt" <= now_utc AND NEW."state" <> 'needs_lookup' THEN
                RAISE EXCEPTION 'EngineeringAgentWorkItem % lease has passed; only a lookup follows', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
            -- A publish is the consumption of a capability: a write claim
            -- publishes on the one it consumed itself, a lookup claim only on
            -- finding one an earlier write claim consumed. A consumed
            -- capability stays consumed (§10). When a write claim is refused
            -- before writing, or a lookup proves no earlier write happened, the
            -- item returns to the queue and its next write claim is judged
            -- again under a new capability (§10), so an item holds several
            -- capabilities over its life, at most one of them unconsumed.
            IF OLD."kind" = 'publish' AND OLD."state" = 'claimed' AND NEW."state" = 'published' THEN
                IF OLD."claimMode" = 'write' THEN
                    EXECUTE pg_catalog.format(
                        'SELECT c."claimFencingToken" FROM %I."EngineeringAgentCapability" c'
                        ' WHERE c."workItemId" = $1 AND c."consumedAt" IS NOT NULL AND c."claimFencingToken" = $2'
                        ' LIMIT 1 FOR UPDATE',
                        TG_TABLE_SCHEMA
                    ) INTO consumed_token USING OLD."id", OLD."fencingToken";
                ELSE
                    EXECUTE pg_catalog.format(
                        'SELECT c."claimFencingToken" FROM %I."EngineeringAgentCapability" c'
                        ' WHERE c."workItemId" = $1 AND c."consumedAt" IS NOT NULL AND c."claimFencingToken" < $2'
                        ' LIMIT 1 FOR UPDATE',
                        TG_TABLE_SCHEMA
                    ) INTO consumed_token USING OLD."id", OLD."fencingToken";
                END IF;
                IF consumed_token IS NULL THEN
                    RAISE EXCEPTION 'EngineeringAgentWorkItem % publishes only on a consumed capability', OLD."id"
                        USING ERRCODE = 'check_violation';
                END IF;
            END IF;
            -- A T2 decision is written first, in the same transaction, and must
            -- agree; a draft with a decision never merely expires.
            IF OLD."kind" = 't2_draft' THEN
                EXECUTE pg_catalog.format(
                    'SELECT EXISTS (SELECT 1 FROM %I."EngineeringAgentApproval" a'
                    ' WHERE a."workItemId" = $1 AND ($2 = ''expired'' OR a."decision" = $2))',
                    TG_TABLE_SCHEMA
                ) INTO decided USING OLD."id", NEW."state";
                IF NEW."state" IN ('approved', 'rejected') AND NOT decided THEN
                    RAISE EXCEPTION 'EngineeringAgentWorkItem % has no matching decision', OLD."id"
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW."state" = 'expired' AND decided THEN
                    RAISE EXCEPTION 'EngineeringAgentWorkItem % was decided and does not expire', OLD."id"
                        USING ERRCODE = 'check_violation';
                END IF;
            END IF;
            NEW."claimMode" := NULL;
            NEW."leaseExpiresAt" := NULL;
            IF NEW."state" NOT IN ('queued', 'needs_lookup', 'outcome_unknown') THEN
                NEW."closedAt" := now_utc;
            END IF;
        END IF;
    ELSIF NEW."fencingToken" IS DISTINCT FROM OLD."fencingToken"
        OR NEW."claimMode" IS DISTINCT FROM OLD."claimMode"
        OR NEW."leaseExpiresAt" IS DISTINCT FROM OLD."leaseExpiresAt"
        OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt" THEN
        RAISE EXCEPTION 'EngineeringAgentWorkItem % claim fields move only with its state', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    NEW."updatedAt" := now_utc;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "engineering_agent_work_item_guard_insert"
    BEFORE INSERT ON "EngineeringAgentWorkItem"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_work_item_guard"();
CREATE TRIGGER "engineering_agent_work_item_guard_update"
    BEFORE UPDATE ON "EngineeringAgentWorkItem"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_work_item_guard"();
CREATE TRIGGER "engineering_agent_work_item_guard_delete"
    BEFORE DELETE ON "EngineeringAgentWorkItem"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_work_item_guard"();

-- An unknown write outcome is handed to a person in the same transaction
-- (§10): by commit, a decision item for exactly this entry -- the item and
-- the claim that ended there -- is open, and it counts in the owner queue.
CREATE OR REPLACE FUNCTION "engineering_agent_unknown_outcome_opens_decision"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    -- cause: UNKNOWN_OUTCOME_DECISION_CAUSE_PREFIX
    cause_prefix CONSTANT TEXT := 'unknown:';
    decision_open BOOLEAN;
BEGIN
    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I."EngineeringAgentWorkItem" w'
        ' WHERE w."causeKey" = $1 AND w."kind" = $2 AND w."state" = $3)',
        TG_TABLE_SCHEMA
    ) INTO decision_open USING cause_prefix || NEW."id" || ':' || NEW."fencingToken", 'decision', 'open';
    IF NOT decision_open THEN
        RAISE EXCEPTION 'EngineeringAgentWorkItem % entered outcome_unknown without an open decision item', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "engineering_agent_unknown_outcome_opens_decision"
    AFTER UPDATE ON "EngineeringAgentWorkItem"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW."state" = 'outcome_unknown' AND OLD."state" IS DISTINCT FROM 'outcome_unknown')
    EXECUTE FUNCTION "engineering_agent_unknown_outcome_opens_decision"();

-- ---------------------------------------------------------------------------
-- EngineeringAgentApproval: a T2 decision, and nothing else (§7). Written
-- once, before the draft closes, and never changed or removed.
-- ---------------------------------------------------------------------------

CREATE TABLE "EngineeringAgentApproval" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "patchDigest" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngineeringAgentApproval_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EngineeringAgentApproval"
    ADD CONSTRAINT "EngineeringAgentApproval_workItemId_key" UNIQUE ("workItemId"),
    ADD CONSTRAINT "EngineeringAgentApproval_auditLogId_key" UNIQUE ("auditLogId"),
    ADD CONSTRAINT "EngineeringAgentApproval_decision_check" CHECK ("decision" IN ('approved', 'rejected')),
    ADD CONSTRAINT "EngineeringAgentApproval_patchDigest_check" CHECK ("patchDigest" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "EngineeringAgentApproval_baseSha_check" CHECK ("baseSha" ~ '^[0-9a-f]{40}$');

ALTER TABLE "EngineeringAgentApproval"
    ADD CONSTRAINT "EngineeringAgentApproval_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "EngineeringAgentWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "EngineeringAgentApproval_auditLogId_fkey"
        FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "engineering_agent_approval_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    item RECORD;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'EngineeringAgentApproval is written once and kept' USING ERRCODE = 'check_violation';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT w."kind", w."state", w."patchDigest", w."baseSha" FROM %I."EngineeringAgentWorkItem" w'
        ' WHERE w."id" = $1 FOR UPDATE',
        TG_TABLE_SCHEMA
    ) INTO item USING NEW."workItemId";
    IF item."kind" IS NULL OR item."kind" <> 't2_draft' OR item."state" <> 'open' THEN
        RAISE EXCEPTION 'EngineeringAgentApproval decides only an open T2 draft' USING ERRCODE = 'check_violation';
    END IF;
    -- The decision binds to what the owner saw: the draft's digest and base.
    IF item."patchDigest" IS DISTINCT FROM NEW."patchDigest" OR item."baseSha" IS DISTINCT FROM NEW."baseSha" THEN
        RAISE EXCEPTION 'EngineeringAgentApproval does not match its draft' USING ERRCODE = 'check_violation';
    END IF;
    NEW."decidedAt" := clock_timestamp() AT TIME ZONE 'UTC';
    RETURN NEW;
END;
$$;

CREATE TRIGGER "engineering_agent_approval_guard_insert"
    BEFORE INSERT ON "EngineeringAgentApproval"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_approval_guard"();
CREATE TRIGGER "engineering_agent_approval_guard_change"
    BEFORE UPDATE OR DELETE ON "EngineeringAgentApproval"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_approval_guard"();

-- By the end of the transaction that writes a decision, the draft is closed
-- as decided; a decision never sits beside an open or expired draft.
CREATE OR REPLACE FUNCTION "engineering_agent_approval_closes_draft"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    closed_as_decided BOOLEAN;
BEGIN
    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I."EngineeringAgentWorkItem" w WHERE w."id" = $1 AND w."state" = $2)',
        TG_TABLE_SCHEMA
    ) INTO closed_as_decided USING NEW."workItemId", NEW."decision";
    IF NOT closed_as_decided THEN
        RAISE EXCEPTION 'EngineeringAgentApproval % must close its draft as decided in the same transaction', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "engineering_agent_approval_closes_draft"
    AFTER INSERT ON "EngineeringAgentApproval"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_approval_closes_draft"();

-- ---------------------------------------------------------------------------
-- EngineeringAgentCapability: permission for one publish (§11). Issued to a
-- queued publish item, consumed at most once and irrevocably, immutable after.
-- An item has at most one unconsumed capability at a time; one that expired
-- unconsumed may lapse, and then it can never be consumed.
-- ---------------------------------------------------------------------------

CREATE TABLE "EngineeringAgentCapability" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    -- The work item while this capability is unconsumed and unlapsed, else
    -- NULL; its unique constraint is "one live capability per item".
    "unconsumedWorkItemId" TEXT,
    "baseSha" TEXT NOT NULL,
    "patchDigest" TEXT NOT NULL,
    "expectedTreeId" TEXT NOT NULL,
    "verifierVersion" INTEGER NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "branch" TEXT NOT NULL,
    "commitDigest" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "claimFencingToken" BIGINT,

    CONSTRAINT "EngineeringAgentCapability_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EngineeringAgentCapability"
    -- One live capability per publish item: issuing is a single conditional write.
    ADD CONSTRAINT "EngineeringAgentCapability_unconsumedWorkItemId_key" UNIQUE ("unconsumedWorkItemId"),
    ADD CONSTRAINT "EngineeringAgentCapability_unconsumed_check"
        CHECK ("unconsumedWorkItemId" IS NULL OR ("unconsumedWorkItemId" = "workItemId" AND "consumedAt" IS NULL)),
    ADD CONSTRAINT "EngineeringAgentCapability_hash_check"
        CHECK (
            "baseSha" ~ '^[0-9a-f]{40}$' AND "expectedTreeId" ~ '^[0-9a-f]{40}$'
            AND "patchDigest" ~ '^[0-9a-f]{64}$' AND "commitDigest" ~ '^[0-9a-f]{64}$'
        ),
    ADD CONSTRAINT "EngineeringAgentCapability_branch_check"
        CHECK ("branch" ~ '^agent/engineering/[0-9]{1,12}$'),
    ADD CONSTRAINT "EngineeringAgentCapability_version_check"
        CHECK ("verifierVersion" >= 1 AND "policyVersion" >= 1),
    ADD CONSTRAINT "EngineeringAgentCapability_consumed_check"
        CHECK (("consumedAt" IS NULL) = ("claimFencingToken" IS NULL));

CREATE INDEX "EngineeringAgentCapability_workItemId_idx" ON "EngineeringAgentCapability"("workItemId");

ALTER TABLE "EngineeringAgentCapability"
    ADD CONSTRAINT "EngineeringAgentCapability_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "EngineeringAgentWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "engineering_agent_capability_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    item RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'EngineeringAgentCapability is kept' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        EXECUTE pg_catalog.format(
            'SELECT w."kind", w."state", w."patchDigest", w."baseSha", w."expectedTreeId"'
            ' FROM %I."EngineeringAgentWorkItem" w WHERE w."id" = $1 FOR UPDATE',
            TG_TABLE_SCHEMA
        ) INTO item USING NEW."workItemId";
        IF item."kind" IS NULL OR item."kind" <> 'publish' OR item."state" <> 'queued'
            OR item."patchDigest" IS DISTINCT FROM NEW."patchDigest"
            OR item."baseSha" IS DISTINCT FROM NEW."baseSha"
            OR item."expectedTreeId" IS DISTINCT FROM NEW."expectedTreeId" THEN
            RAISE EXCEPTION 'EngineeringAgentCapability must match a queued publish item'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."consumedAt" IS NOT NULL OR NEW."claimFencingToken" IS NOT NULL OR NEW."expiresAt" <= now_utc THEN
            RAISE EXCEPTION 'EngineeringAgentCapability is issued unconsumed and unexpired'
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."issuedAt" := now_utc;
        NEW."unconsumedWorkItemId" := NEW."workItemId";
        RETURN NEW;
    END IF;

    IF OLD."consumedAt" IS NOT NULL OR OLD."unconsumedWorkItemId" IS NULL THEN
        RAISE EXCEPTION 'EngineeringAgentCapability % is consumed or lapsed, and immutable', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."workItemId" IS DISTINCT FROM OLD."workItemId"
        OR NEW."baseSha" IS DISTINCT FROM OLD."baseSha"
        OR NEW."patchDigest" IS DISTINCT FROM OLD."patchDigest"
        OR NEW."expectedTreeId" IS DISTINCT FROM OLD."expectedTreeId"
        OR NEW."verifierVersion" IS DISTINCT FROM OLD."verifierVersion"
        OR NEW."policyVersion" IS DISTINCT FROM OLD."policyVersion"
        OR NEW."branch" IS DISTINCT FROM OLD."branch"
        OR NEW."commitDigest" IS DISTINCT FROM OLD."commitDigest"
        OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
        OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
        RAISE EXCEPTION 'EngineeringAgentCapability % binds what it was issued for', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    -- Two changes, each once. A capability that expired unconsumed may
    -- lapse, which frees its item for a new one and never allows consumption.
    IF NEW."consumedAt" IS NULL AND NEW."claimFencingToken" IS NULL THEN
        IF NEW."unconsumedWorkItemId" IS NULL THEN
            IF OLD."expiresAt" > now_utc THEN
                RAISE EXCEPTION 'EngineeringAgentCapability % lapses only after it expires', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        ELSIF NEW."unconsumedWorkItemId" IS DISTINCT FROM OLD."unconsumedWorkItemId" THEN
            RAISE EXCEPTION 'EngineeringAgentCapability % binds what it was issued for', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    -- Otherwise consumption: before expiry, by the claim that holds the
    -- publish item's current fencing token while its lease lives.
    IF OLD."expiresAt" <= now_utc THEN
        RAISE EXCEPTION 'EngineeringAgentCapability % has expired', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT w."state", w."claimMode", w."fencingToken", w."leaseExpiresAt"'
        ' FROM %I."EngineeringAgentWorkItem" w WHERE w."id" = $1 FOR UPDATE',
        TG_TABLE_SCHEMA
    ) INTO item USING OLD."workItemId";
    IF item."state" IS DISTINCT FROM 'claimed' OR item."claimMode" IS DISTINCT FROM 'write'
        OR item."fencingToken" IS DISTINCT FROM NEW."claimFencingToken"
        OR item."leaseExpiresAt" <= now_utc THEN
        RAISE EXCEPTION 'EngineeringAgentCapability % is consumed only by the current, live write claim', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    NEW."consumedAt" := now_utc;
    NEW."unconsumedWorkItemId" := NULL;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "engineering_agent_capability_guard_insert"
    BEFORE INSERT ON "EngineeringAgentCapability"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_capability_guard"();
CREATE TRIGGER "engineering_agent_capability_guard_change"
    BEFORE UPDATE OR DELETE ON "EngineeringAgentCapability"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_capability_guard"();

-- ---------------------------------------------------------------------------
-- EngineeringAgentBinding: a published pull request, as the app bound it.
-- The snapshot never changes; a replacement is a new row, and exactly one
-- row per pull request is current.
-- ---------------------------------------------------------------------------

CREATE TABLE "EngineeringAgentBinding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "verifiedHeadSha" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "snapshot" JSONB NOT NULL,
    "approvalObservation" JSONB,
    "mergeObservation" JSONB,
    "reviewerGithubId" BIGINT,
    "reviewerLogin" TEXT,
    "reviewerRecordedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    -- The pull request number while this row is current, else NULL; its
    -- unique constraint is "one current row per pull request".
    "currentPrNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngineeringAgentBinding_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EngineeringAgentBinding"
    ADD CONSTRAINT "EngineeringAgentBinding_state_check" CHECK ("state" IN ('open', 'closed', 'pruned')),
    ADD CONSTRAINT "EngineeringAgentBinding_sha_check"
        CHECK ("headSha" ~ '^[0-9a-f]{40}$' AND "verifiedHeadSha" ~ '^[0-9a-f]{40}$'),
    ADD CONSTRAINT "EngineeringAgentBinding_ref_check"
        CHECK ("ref" ~ '^agent/engineering/[0-9]{1,12}$' AND "ref" = 'agent/engineering/' || "runId"),
    ADD CONSTRAINT "EngineeringAgentBinding_prNumber_check" CHECK ("prNumber" > 0),
    ADD CONSTRAINT "EngineeringAgentBinding_reviewerLogin_check"
        CHECK ("reviewerLogin" IS NULL OR "reviewerLogin" ~ '^[A-Za-z0-9-]{1,39}$'),
    -- The reviewer is a pair: both present, or both removed by retention
    -- with the record of when it was taken kept.
    ADD CONSTRAINT "EngineeringAgentBinding_reviewer_pair_check"
        CHECK (
            ("reviewerGithubId" IS NULL) = ("reviewerLogin" IS NULL)
            AND ("reviewerGithubId" IS NULL OR "reviewerRecordedAt" IS NOT NULL)
        ),
    ADD CONSTRAINT "EngineeringAgentBinding_currentPrNumber_key" UNIQUE ("currentPrNumber"),
    ADD CONSTRAINT "EngineeringAgentBinding_current_check"
        CHECK (
            ("supersededAt" IS NULL) = ("currentPrNumber" IS NOT NULL)
            AND ("currentPrNumber" IS NULL OR "currentPrNumber" = "prNumber")
        ),
    -- The JSON columns hold digests, enums, review ids and instants: no free
    -- text, and no person (the reviewer has its own columns, which retention
    -- clears). Key sets are exact, and each value has its shape and a size.
    ADD CONSTRAINT "EngineeringAgentBinding_snapshot_check"
        CHECK (
            jsonb_typeof("snapshot") = 'object'
            AND octet_length("snapshot"::text) <= 4096
            AND "snapshot" ?& ARRAY['baseSha', 'diffDigest', 'treeId', 'invalidatedReviewIds']
            AND "snapshot" - ARRAY['baseSha', 'diffDigest', 'treeId', 'invalidatedReviewIds'] = '{}'::jsonb
            AND jsonb_typeof("snapshot"->'baseSha') = 'string' AND "snapshot"->>'baseSha' ~ '^[0-9a-f]{40}$'
            AND jsonb_typeof("snapshot"->'diffDigest') = 'string' AND "snapshot"->>'diffDigest' ~ '^[0-9a-f]{64}$'
            AND jsonb_typeof("snapshot"->'treeId') = 'string' AND "snapshot"->>'treeId' ~ '^[0-9a-f]{40}$'
            AND jsonb_typeof("snapshot"->'invalidatedReviewIds') = 'array'
            AND jsonb_array_length("snapshot"->'invalidatedReviewIds') <= 100
            AND NOT jsonb_path_exists(
                "snapshot", '$.invalidatedReviewIds[*] ? (@.type() != "number" || @ < 1 || @.floor() != @)')
        ),
    ADD CONSTRAINT "EngineeringAgentBinding_approvalObservation_check"
        CHECK (
            "approvalObservation" IS NULL OR (
                jsonb_typeof("approvalObservation") = 'object'
                AND octet_length("approvalObservation"::text) <= 1024
                AND jsonb_typeof("approvalObservation"->'observedAt') = 'string'
                AND "approvalObservation"->>'observedAt'
                    ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
                AND (
                    (
                        "approvalObservation"->>'verdict' = 'approved'
                        AND "approvalObservation" ?& ARRAY['verdict', 'reviewId', 'reviewCommitId', 'submittedAt', 'observedAt']
                        AND "approvalObservation"
                            - ARRAY['verdict', 'reviewId', 'reviewCommitId', 'submittedAt', 'observedAt'] = '{}'::jsonb
                        AND jsonb_typeof("approvalObservation"->'reviewId') = 'number'
                        AND jsonb_typeof("approvalObservation"->'reviewCommitId') = 'string'
                        AND "approvalObservation"->>'reviewCommitId' ~ '^[0-9a-f]{40}$'
                        AND jsonb_typeof("approvalObservation"->'submittedAt') = 'string'
                        AND "approvalObservation"->>'submittedAt'
                            ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
                    )
                    OR (
                        "approvalObservation"->>'verdict' = 'not_approved'
                        AND "approvalObservation" ?& ARRAY['verdict', 'reason', 'observedAt']
                        AND "approvalObservation" - ARRAY['verdict', 'reason', 'observedAt'] = '{}'::jsonb
                        -- reasons: ENGINEERING_AGENT_NOT_APPROVED_REASONS
                        AND "approvalObservation"->>'reason' IN (
                            'base_not_develop', 'head_not_verified', 'required_check_failed', 'no_authorised_review',
                            'review_not_valid', 'snapshot_changed', 'review_before_snapshot', 'merged_without_approval'
                        )
                    )
                )
            )
        ),
    ADD CONSTRAINT "EngineeringAgentBinding_mergeObservation_check"
        CHECK (
            "mergeObservation" IS NULL OR (
                jsonb_typeof("mergeObservation") = 'object'
                AND octet_length("mergeObservation"::text) <= 1024
                AND "mergeObservation" ?& ARRAY['merged', 'mergeCommitSha', 'mergedAt', 'mergedByKind', 'observedAt']
                AND "mergeObservation"
                    - ARRAY['merged', 'mergeCommitSha', 'mergedAt', 'mergedByKind', 'observedAt'] = '{}'::jsonb
                -- mergers: ENGINEERING_AGENT_MERGER_KINDS
                AND "mergeObservation"->>'mergedByKind' IN ('user', 'bot', 'app', 'unknown')
                AND jsonb_typeof("mergeObservation"->'observedAt') = 'string'
                AND "mergeObservation"->>'observedAt'
                    ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
                AND (
                    (
                        "mergeObservation"->'merged' = 'true'::jsonb
                        AND jsonb_typeof("mergeObservation"->'mergeCommitSha') = 'string'
                        AND "mergeObservation"->>'mergeCommitSha' ~ '^[0-9a-f]{40}$'
                        AND jsonb_typeof("mergeObservation"->'mergedAt') = 'string'
                        AND "mergeObservation"->>'mergedAt'
                            ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
                    )
                    OR (
                        "mergeObservation"->'merged' = 'false'::jsonb
                        AND jsonb_typeof("mergeObservation"->'mergeCommitSha') = 'null'
                        AND jsonb_typeof("mergeObservation"->'mergedAt') = 'null'
                    )
                )
            )
        );

CREATE INDEX "EngineeringAgentBinding_runId_idx" ON "EngineeringAgentBinding"("runId");
CREATE INDEX "EngineeringAgentBinding_state_idx" ON "EngineeringAgentBinding"("state");

ALTER TABLE "EngineeringAgentBinding"
    ADD CONSTRAINT "EngineeringAgentBinding_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "EngineeringAgentRun"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "engineering_agent_binding_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'open' OR NEW."supersededAt" IS NOT NULL
            OR NEW."approvalObservation" IS NOT NULL OR NEW."mergeObservation" IS NOT NULL
            OR NEW."reviewerGithubId" IS NOT NULL OR NEW."reviewerLogin" IS NOT NULL OR NEW."reviewerRecordedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'EngineeringAgentBinding starts open, current and unobserved' USING ERRCODE = 'check_violation';
        END IF;
        NEW."currentPrNumber" := NEW."prNumber";
        NEW."createdAt" := now_utc;
        NEW."updatedAt" := now_utc;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF OLD."state" <> 'pruned' THEN
            RAISE EXCEPTION 'only a pruned EngineeringAgentBinding can be deleted' USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."runId" IS DISTINCT FROM OLD."runId"
        OR NEW."prNumber" IS DISTINCT FROM OLD."prNumber"
        OR NEW."headSha" IS DISTINCT FROM OLD."headSha"
        OR NEW."verifiedHeadSha" IS DISTINCT FROM OLD."verifiedHeadSha"
        OR NEW."ref" IS DISTINCT FROM OLD."ref"
        OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'EngineeringAgentBinding % snapshot is immutable; bind a new row instead', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    -- Superseding is written once, at the database's time, and a
    -- replacement must be current by commit (below).
    IF OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt" THEN
        RAISE EXCEPTION 'EngineeringAgentBinding % was superseded', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."supersededAt" IS NULL AND NEW."supersededAt" IS NOT NULL THEN
        NEW."supersededAt" := now_utc;
    END IF;
    -- A row is current exactly while it is not superseded, and the database
    -- keeps that slot: a caller does not write it.
    IF NEW."currentPrNumber" IS DISTINCT FROM OLD."currentPrNumber" THEN
        RAISE EXCEPTION 'EngineeringAgentBinding currentPrNumber is written by the database'
            USING ERRCODE = 'check_violation';
    END IF;
    NEW."currentPrNumber" := CASE WHEN NEW."supersededAt" IS NULL THEN OLD."currentPrNumber" ELSE NULL END;
    IF NEW."state" IS DISTINCT FROM OLD."state" AND (OLD."state", NEW."state") NOT IN (
        -- transitions: EngineeringAgentBinding binding
        ('open', 'closed'),
        ('closed', 'pruned')
        -- end transitions
    ) THEN
        RAISE EXCEPTION 'EngineeringAgentBinding % cannot go from % to %', OLD."id", OLD."state", NEW."state"
            USING ERRCODE = 'check_violation';
    END IF;
    -- An observation is recorded once, from nothing, and never rewritten.
    IF (OLD."approvalObservation" IS NOT NULL AND NEW."approvalObservation" IS DISTINCT FROM OLD."approvalObservation")
        OR (OLD."mergeObservation" IS NOT NULL AND NEW."mergeObservation" IS DISTINCT FROM OLD."mergeObservation") THEN
        RAISE EXCEPTION 'EngineeringAgentBinding % observations are recorded once', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    -- A reviewer is recorded once, as a pair. Retention may remove the pair;
    -- nothing may remove half of it, put one back or put another in its place.
    IF NEW."reviewerRecordedAt" IS DISTINCT FROM OLD."reviewerRecordedAt" THEN
        RAISE EXCEPTION 'EngineeringAgentBinding reviewerRecordedAt is written by the database'
            USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."reviewerGithubId" IS NULL) <> (NEW."reviewerLogin" IS NULL) THEN
        RAISE EXCEPTION 'EngineeringAgentBinding % reviewer is recorded and removed whole', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."reviewerGithubId" IS NOT NULL AND NEW."reviewerGithubId" IS DISTINCT FROM OLD."reviewerGithubId")
        OR (NEW."reviewerLogin" IS NOT NULL AND NEW."reviewerLogin" IS DISTINCT FROM OLD."reviewerLogin") THEN
        IF OLD."reviewerRecordedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'EngineeringAgentBinding % reviewer was recorded once', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."reviewerRecordedAt" := now_utc;
    END IF;
    NEW."updatedAt" := now_utc;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "engineering_agent_binding_guard_insert"
    BEFORE INSERT ON "EngineeringAgentBinding"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_binding_guard"();
CREATE TRIGGER "engineering_agent_binding_guard_change"
    BEFORE UPDATE OR DELETE ON "EngineeringAgentBinding"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_binding_guard"();

-- A superseded binding leaves a current one for the same pull request by
-- commit, and that one is still counted -- open or closed, not already
-- pruned -- so an open PR never drops out of the owner queue's count.
CREATE OR REPLACE FUNCTION "engineering_agent_binding_superseded_has_replacement"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    replaced BOOLEAN;
BEGIN
    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I."EngineeringAgentBinding" b'
        ' WHERE b."currentPrNumber" = $1 AND b."id" <> $2 AND b."state" = ANY ($3))',
        TG_TABLE_SCHEMA
    ) INTO replaced USING NEW."prNumber", NEW."id", ARRAY['open', 'closed'];
    IF NOT replaced THEN
        RAISE EXCEPTION 'EngineeringAgentBinding % was superseded without a current replacement', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "engineering_agent_binding_superseded_has_replacement"
    AFTER UPDATE ON "EngineeringAgentBinding"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD."supersededAt" IS NULL AND NEW."supersededAt" IS NOT NULL)
    EXECUTE FUNCTION "engineering_agent_binding_superseded_has_replacement"();

-- ---------------------------------------------------------------------------
-- EngineeringAgentRegistration: a registration proposal's source, digests,
-- guard result and AMUX card, without the proposal body (§2.2, §11). No
-- writer exists until the AMUX intake has an agent registration source.
-- ---------------------------------------------------------------------------

CREATE TABLE "EngineeringAgentRegistration" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "pinnedCommit" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "itemDigest" TEXT NOT NULL,
    "proposalDigest" TEXT NOT NULL,
    "guardResult" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'pending',
    "amuxCardId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "EngineeringAgentRegistration_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EngineeringAgentRegistration"
    ADD CONSTRAINT "EngineeringAgentRegistration_source_itemKey_itemDigest_key"
        UNIQUE ("source", "itemKey", "itemDigest"),
    ADD CONSTRAINT "EngineeringAgentRegistration_id_check" CHECK ("id" ~ '^[A-Za-z0-9_-]{1,64}$'),
    ADD CONSTRAINT "EngineeringAgentRegistration_source_check" CHECK ("source" IN ('S1', 'S2', 'S3')),
    ADD CONSTRAINT "EngineeringAgentRegistration_hash_check"
        CHECK (
            "pinnedCommit" ~ '^[0-9a-f]{40}$' AND "itemDigest" ~ '^[0-9a-f]{64}$'
            AND "proposalDigest" ~ '^[0-9a-f]{64}$'
        ),
    ADD CONSTRAINT "EngineeringAgentRegistration_itemKey_check" CHECK ("itemKey" ~ '^[!-~]{1,120}$'),
    ADD CONSTRAINT "EngineeringAgentRegistration_guardResult_check" CHECK ("guardResult" ~ '^[a-z_]{1,64}$'),
    ADD CONSTRAINT "EngineeringAgentRegistration_result_check"
        CHECK ("result" IN ('pending', 'registered', 'registration_refused', 'absent', 'partial')),
    ADD CONSTRAINT "EngineeringAgentRegistration_card_check"
        CHECK (("result" = 'registered') = ("amuxCardId" IS NOT NULL)),
    ADD CONSTRAINT "EngineeringAgentRegistration_roundId_check" CHECK ("roundId" ~ '^[A-Za-z0-9_-]{8,64}$');

CREATE INDEX "EngineeringAgentRegistration_roundId_idx" ON "EngineeringAgentRegistration"("roundId");
CREATE INDEX "EngineeringAgentRegistration_result_createdAt_idx"
    ON "EngineeringAgentRegistration"("result", "createdAt");

ALTER TABLE "EngineeringAgentRegistration"
    ADD CONSTRAINT "EngineeringAgentRegistration_amuxCardId_fkey"
        FOREIGN KEY ("amuxCardId") REFERENCES "AmuxWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "engineering_agent_registration_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    -- limit: REGISTRATION_CAPS.perRound
    round_limit CONSTANT INTEGER := 3;
    -- limit: REGISTRATION_CAPS.perUtcDay
    day_limit CONSTANT INTEGER := 10;
    -- limit: REGISTRATION_CAPS.unpromoted
    unpromoted_limit CONSTANT INTEGER := 20;
    counted INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."result" <> 'pending' OR NEW."decidedAt" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'EngineeringAgentRegistration starts pending' USING ERRCODE = 'check_violation';
        END IF;
        -- The caps (policy §2.2), counted here and not only by the guard.
        -- A proposal that did not become a card -- refused, or confirmed
        -- absent -- does not count; one whose card is unknown does.
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('engineering-agent:registration'));
        EXECUTE pg_catalog.format(
            'SELECT count(*) FROM %I."EngineeringAgentRegistration" r'
            ' WHERE r."roundId" = $1 AND r."result" <> ALL ($2)',
            TG_TABLE_SCHEMA
        ) INTO counted USING NEW."roundId", ARRAY['registration_refused', 'absent'];
        IF counted >= round_limit THEN
            RAISE EXCEPTION 'EngineeringAgentRegistration refused: the round cap is reached' USING ERRCODE = 'check_violation';
        END IF;
        EXECUTE pg_catalog.format(
            'SELECT count(*) FROM %I."EngineeringAgentRegistration" r'
            ' WHERE r."createdAt" >= $1 AND r."result" <> ALL ($2)',
            TG_TABLE_SCHEMA
        ) INTO counted USING pg_catalog.date_trunc('day', now_utc), ARRAY['registration_refused', 'absent'];
        IF counted >= day_limit THEN
            RAISE EXCEPTION 'EngineeringAgentRegistration refused: the UTC day cap is reached' USING ERRCODE = 'check_violation';
        END IF;
        EXECUTE pg_catalog.format(
            'SELECT count(*) FROM %1$I."EngineeringAgentRegistration" r'
            ' LEFT JOIN %1$I."AmuxWorkItem" c ON c."id" = r."amuxCardId"'
            ' WHERE r."result" = ANY ($1)'
            '    OR (r."result" = $2 AND c."status" = $3 AND c."archivedAt" IS NULL)',
            TG_TABLE_SCHEMA
        ) INTO counted USING ARRAY['pending', 'partial'], 'registered', 'backlog';
        IF counted >= unpromoted_limit THEN
            RAISE EXCEPTION 'EngineeringAgentRegistration refused: too many registered cards wait for promotion'
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."createdAt" := now_utc;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' OR OLD."result" NOT IN ('pending', 'partial') THEN
        RAISE EXCEPTION 'EngineeringAgentRegistration result is written once and kept'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."source" IS DISTINCT FROM OLD."source"
        OR NEW."pinnedCommit" IS DISTINCT FROM OLD."pinnedCommit"
        OR NEW."itemKey" IS DISTINCT FROM OLD."itemKey"
        OR NEW."itemDigest" IS DISTINCT FROM OLD."itemDigest"
        OR NEW."proposalDigest" IS DISTINCT FROM OLD."proposalDigest"
        OR NEW."guardResult" IS DISTINCT FROM OLD."guardResult"
        OR NEW."roundId" IS DISTINCT FROM OLD."roundId"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'EngineeringAgentRegistration % cannot change what was proposed', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."result", NEW."result") NOT IN (
        -- transitions: EngineeringAgentRegistration registration
        ('pending', 'registered'),
        ('pending', 'registration_refused'),
        ('pending', 'absent'),
        ('pending', 'partial'),
        ('partial', 'registered'),
        ('partial', 'absent')
        -- end transitions
    ) THEN
        RAISE EXCEPTION 'EngineeringAgentRegistration % cannot go from % to %', OLD."id", OLD."result", NEW."result"
            USING ERRCODE = 'check_violation';
    END IF;
    -- The first answer is kept as decided; a partial one's later resolution
    -- is recorded beside it, not over it.
    IF OLD."result" = 'pending' THEN
        NEW."decidedAt" := now_utc;
        NEW."resolvedAt" := NULL;
    ELSE
        NEW."decidedAt" := OLD."decidedAt";
        NEW."resolvedAt" := now_utc;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "engineering_agent_registration_guard_insert"
    BEFORE INSERT ON "EngineeringAgentRegistration"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_registration_guard"();
CREATE TRIGGER "engineering_agent_registration_guard_change"
    BEFORE UPDATE OR DELETE ON "EngineeringAgentRegistration"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_registration_guard"();

-- A partial registration is an owner decision (§12, "등록 결과 불명"): it
-- opens a decision item in the same transaction, and that item -- which
-- expires or is acknowledged -- is what the owner queue counts. It is
-- resolved only after that item has closed, so a person has seen it first.
CREATE OR REPLACE FUNCTION "engineering_agent_partial_registration_decision"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    -- cause: PARTIAL_REGISTRATION_DECISION_CAUSE_PREFIX
    cause_prefix CONSTANT TEXT := 'registration:';
    decision_state TEXT;
BEGIN
    EXECUTE pg_catalog.format(
        'SELECT w."state" FROM %I."EngineeringAgentWorkItem" w WHERE w."causeKey" = $1 AND w."kind" = $2',
        TG_TABLE_SCHEMA
    ) INTO decision_state USING cause_prefix || NEW."id", 'decision';
    IF NEW."result" = 'partial' AND decision_state IS DISTINCT FROM 'open' THEN
        RAISE EXCEPTION 'EngineeringAgentRegistration % became partial without an open decision item', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."result" <> 'partial' AND (decision_state IS NULL OR decision_state = 'open') THEN
        RAISE EXCEPTION 'EngineeringAgentRegistration % is resolved only after its decision item closes', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "engineering_agent_partial_registration_decision"
    AFTER UPDATE ON "EngineeringAgentRegistration"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW."result" = 'partial' OR OLD."result" = 'partial')
    EXECUTE FUNCTION "engineering_agent_partial_registration_decision"();

-- ---------------------------------------------------------------------------
-- EngineeringAgentRequest: internal request idempotency (§10). `in_progress`
-- may stay visible indefinitely, because a COMMIT can land late; nothing here
-- moves it on a timer.
-- ---------------------------------------------------------------------------

CREATE TABLE "EngineeringAgentRequest" (
    "key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'accepted',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngineeringAgentRequest_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "EngineeringAgentRequest"
    ADD CONSTRAINT "EngineeringAgentRequest_key_check" CHECK ("key" ~ '^[A-Za-z0-9_-]{16,128}$'),
    ADD CONSTRAINT "EngineeringAgentRequest_route_check" CHECK ("route" ~ '^[a-z]+/[a-z-]+$'),
    ADD CONSTRAINT "EngineeringAgentRequest_requestDigest_check" CHECK ("requestDigest" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "EngineeringAgentRequest_state_check"
        CHECK ("state" IN ('accepted', 'in_progress', 'committed', 'aborted'));

CREATE INDEX "EngineeringAgentRequest_state_createdAt_idx" ON "EngineeringAgentRequest"("state", "createdAt");

CREATE OR REPLACE FUNCTION "engineering_agent_request_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'accepted' THEN
            RAISE EXCEPTION 'EngineeringAgentRequest starts accepted' USING ERRCODE = 'check_violation';
        END IF;
        NEW."createdAt" := now_utc;
        NEW."updatedAt" := now_utc;
        RETURN NEW;
    END IF;
    -- A request's end is what makes a retry idempotent; it is never deleted.
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'EngineeringAgentRequest is kept' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."key" IS DISTINCT FROM OLD."key"
        OR NEW."route" IS DISTINCT FROM OLD."route"
        OR NEW."requestDigest" IS DISTINCT FROM OLD."requestDigest"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'EngineeringAgentRequest % cannot change what was asked', OLD."key"
            USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."state", NEW."state") NOT IN (
        -- transitions: EngineeringAgentRequest request
        ('accepted', 'in_progress'),
        ('accepted', 'aborted'),
        ('in_progress', 'committed'),
        ('in_progress', 'aborted')
        -- end transitions
    ) THEN
        RAISE EXCEPTION 'EngineeringAgentRequest % cannot go from % to %', OLD."key", OLD."state", NEW."state"
            USING ERRCODE = 'check_violation';
    END IF;
    NEW."updatedAt" := now_utc;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "engineering_agent_request_guard_insert"
    BEFORE INSERT ON "EngineeringAgentRequest"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_request_guard"();
CREATE TRIGGER "engineering_agent_request_guard_change"
    BEFORE UPDATE OR DELETE ON "EngineeringAgentRequest"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_request_guard"();

COMMIT;
