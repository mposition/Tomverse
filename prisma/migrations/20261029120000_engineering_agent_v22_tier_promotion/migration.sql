-- A v22 Task settles its patch as a `tier_pending` T2 draft: reading the
-- tier needs the base tree from GitHub and a source analysis that no
-- settlement route budget holds (production, 2026-10-28: settle 499 after
-- 27 s). Owner decision 2026-10-29: the publisher's round reads the tier
-- afterwards. A T1 verdict closes the draft as `expired` with reason
-- `publish_promoted` and opens the finished run's publish item with the same
-- patch (docs/policy/engineering-agent.md §4). This replaces the work item
-- guard's body only: its insert rule admits that one publish item, still
-- one product per run, still only from a run that started under `t1`, and
-- only into a pull request queue with room. No table, constraint or row
-- changes.
-- baseline-check: replace-function-if-body-sha256 "engineering_agent_work_item_guard" "204ee684f357a7539fbe8a30b7e9f8af5e167cff1b25e7148167303393d6d711"
BEGIN;

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
    producer RECORD;
    products BIGINT;
    -- limit: OWNER_QUEUE_LIMITS.pr
    pr_limit CONSTANT INTEGER := 2;
    -- limit: OWNER_QUEUE_LIMITS.prDuringFirstT1Days
    first_t1_pr_limit CONSTANT INTEGER := 1;
    -- limit: FIRST_T1_WINDOW_DAYS
    first_t1_days CONSTANT INTEGER := 14;
    -- reason: ENGINEERING_AGENT_V22_PROMOTED_REASON
    promoted_reason CONSTANT TEXT := 'publish_promoted';
    promoted BOOLEAN := FALSE;
    effective_pr_limit INTEGER;
    open_prs BIGINT;
    active_runs BIGINT;
    t1_started TIMESTAMP(3);
BEGIN
    -- Work items are kept: they are what the owner queue and the audit trail
    -- point at. A retention period for patch bodies is a later migration.
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'EngineeringAgentWorkItem is kept' USING ERRCODE = 'check_violation';
    END IF;

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
        -- A draft or a publish item is the one product of a run that is
        -- still active: the owner queue admitted that run with room for what
        -- it makes (the run trigger counts active runs), so its product takes
        -- the room the run held and cannot add to the queue beyond the cap. A
        -- publish item comes only from a run that started under `t1`; in
        -- shadow a T1 result is a T2 draft (§11).
        --
        -- The one exception is a v22 draft whose tier was read after its
        -- run ended (§4): once that draft has closed as promoted, the
        -- finished run's publish item may open with the same patch, but only
        -- into a pull request queue with room, counted as a run's admission
        -- counts it. The promoted draft is not a second product.
        IF NEW."kind" IN ('t2_draft', 'publish') THEN
            PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('engineering-agent:owner-queue'));
            EXECUTE pg_catalog.format(
                'SELECT r."status", r."modeAtStart" FROM %I."EngineeringAgentRun" r WHERE r."id" = $1 FOR UPDATE',
                TG_TABLE_SCHEMA
            ) INTO producer USING NEW."runId";
            IF NEW."kind" = 'publish' AND producer."status" = 'finished' THEN
                EXECUTE pg_catalog.format(
                    'SELECT EXISTS (SELECT 1 FROM %I."EngineeringAgentWorkItem" w'
                    ' WHERE w."runId" = $1 AND w."kind" = $2 AND w."state" = $3 AND w."reason" = $4'
                    ' AND w."patchDigest" = $5 AND w."baseSha" = $6)',
                    TG_TABLE_SCHEMA
                ) INTO promoted USING NEW."runId", 't2_draft', 'expired', promoted_reason,
                    NEW."patchDigest", NEW."baseSha";
            END IF;
            IF producer."status" IS DISTINCT FROM 'active' AND NOT promoted THEN
                RAISE EXCEPTION 'EngineeringAgentWorkItem % must be the product of an active run', NEW."kind"
                    USING ERRCODE = 'check_violation';
            END IF;
            IF NEW."kind" = 'publish' AND producer."modeAtStart" IS DISTINCT FROM 't1' THEN
                RAISE EXCEPTION 'EngineeringAgentWorkItem publish must come from a run that started under t1'
                    USING ERRCODE = 'check_violation';
            END IF;
            EXECUTE pg_catalog.format(
                'SELECT count(*) FROM %I."EngineeringAgentWorkItem" w WHERE w."runId" = $1 AND w."kind" = ANY ($2)'
                ' AND NOT ($3 AND w."kind" = $4 AND w."state" = $5 AND w."reason" IS NOT DISTINCT FROM $6)',
                TG_TABLE_SCHEMA
            ) INTO products USING NEW."runId", ARRAY['t2_draft', 'publish'], promoted, 't2_draft', 'expired', promoted_reason;
            IF products > 0 THEN
                RAISE EXCEPTION 'EngineeringAgentWorkItem a run has one product' USING ERRCODE = 'check_violation';
            END IF;
            IF promoted THEN
                EXECUTE pg_catalog.format(
                    'SELECT'
                    ' (SELECT count(*) FROM %1$I."EngineeringAgentBinding" b WHERE b."state" = ANY ($1) AND b."supersededAt" IS NULL)'
                    ' + (SELECT count(*) FROM %1$I."EngineeringAgentWorkItem" w WHERE w."kind" = $2 AND w."state" = ANY ($3)),'
                    ' (SELECT count(*) FROM %1$I."EngineeringAgentRun" r WHERE r."status" = $4),'
                    ' (SELECT min(r."startedAt") FROM %1$I."EngineeringAgentRun" r WHERE r."modeAtStart" = $5)',
                    TG_TABLE_SCHEMA
                ) INTO open_prs, active_runs, t1_started
                USING ARRAY['open', 'closed'], 'publish', ARRAY['queued', 'claimed', 'needs_lookup', 'outcome_unknown'],
                      'active', 't1';
                effective_pr_limit := CASE
                    WHEN t1_started IS NOT NULL AND now_utc < t1_started + first_t1_days * INTERVAL '1 day'
                        THEN first_t1_pr_limit
                    ELSE pr_limit
                END;
                IF open_prs + active_runs >= effective_pr_limit THEN
                    RAISE EXCEPTION 'EngineeringAgentWorkItem refused: the owner queue is full' USING ERRCODE = 'check_violation';
                END IF;
            END IF;
        END IF;
        NEW."createdAt" := now_utc;
        NEW."updatedAt" := now_utc;
        RETURN NEW;
    END IF;

    terminal := OLD."state" NOT IN ('queued', 'claimed', 'needs_lookup', 'outcome_unknown', 'open');

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

COMMIT;
