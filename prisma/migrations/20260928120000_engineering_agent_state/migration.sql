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

BEGIN;

-- ---------------------------------------------------------------------------
-- EngineeringAgentRun: one AMUX execution attempt, 1:1.
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

ALTER TABLE "EngineeringAgentRun"
    ADD CONSTRAINT "EngineeringAgentRun_amuxAttemptId_fkey"
        FOREIGN KEY ("amuxAttemptId") REFERENCES "AmuxExecutionAttempt"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "EngineeringAgentRun_cardId_fkey"
        FOREIGN KEY ("cardId") REFERENCES "AmuxWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "engineering_agent_run_guard"()
RETURNS TRIGGER AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    -- limit: OWNER_QUEUE_LIMITS.pr
    pr_limit CONSTANT INTEGER := 2;
    -- limit: OWNER_QUEUE_LIMITS.decision
    decision_limit CONSTANT INTEGER := 3;
    open_prs INTEGER;
    pending_decisions INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'active' THEN
            RAISE EXCEPTION 'EngineeringAgentRun starts active' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."leaseExpiresAt" <= now_utc THEN
            RAISE EXCEPTION 'EngineeringAgentRun lease is already over' USING ERRCODE = 'check_violation';
        END IF;
        -- The run is the attempt's, on the attempt's own card.
        IF NOT EXISTS (
            SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."id" = NEW."amuxAttemptId" AND a."taskId" = NEW."cardId"
        ) THEN
            RAISE EXCEPTION 'EngineeringAgentRun must bind an attempt to that attempt''s card'
                USING ERRCODE = 'check_violation';
        END IF;
        -- The owner queues (policy §12): a new run is a new claim, and none is
        -- taken while either queue is full. The count is serialised so two
        -- starts cannot both see the last free place. The shorter limit of
        -- the first T1 window depends on the mode's history and is the store's.
        PERFORM pg_advisory_xact_lock(hashtext('engineering-agent:owner-queue'));
        SELECT count(*) INTO open_prs FROM "EngineeringAgentBinding"
            WHERE "state" IN ('open', 'closed') AND "supersededAt" IS NULL;
        SELECT (SELECT count(*) FROM "EngineeringAgentWorkItem"
                    WHERE "kind" IN ('t2_draft', 'decision', 'state_mismatch') AND "state" = 'open')
             + (SELECT count(*) FROM "EngineeringAgentRegistration" WHERE "result" = 'partial')
            INTO pending_decisions;
        IF open_prs >= pr_limit OR pending_decisions >= decision_limit THEN
            RAISE EXCEPTION 'EngineeringAgentRun refused: the owner queue is full' USING ERRCODE = 'check_violation';
        END IF;
        NEW."startedAt" := now_utc;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD."status" = 'active' THEN
            RAISE EXCEPTION 'an active EngineeringAgentRun cannot be deleted' USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
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
$$ LANGUAGE plpgsql;

CREATE TRIGGER "engineering_agent_run_guard_insert"
    BEFORE INSERT ON "EngineeringAgentRun"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_run_guard"();
CREATE TRIGGER "engineering_agent_run_guard_update"
    BEFORE UPDATE ON "EngineeringAgentRun"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_run_guard"();
CREATE TRIGGER "engineering_agent_run_guard_delete"
    BEFORE DELETE ON "EngineeringAgentRun"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_run_guard"();

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
    ADD CONSTRAINT "EngineeringAgentWorkItem_causeKey_check" CHECK ("causeKey" ~ '^[a-z_]{1,20}:[!-~]{1,200}$'),
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
    -- A draft and a publish item carry what they are about; a patch body is
    -- only ever a draft's.
    ADD CONSTRAINT "EngineeringAgentWorkItem_payload_check"
        CHECK (
            ("kind" = 't2_draft' AND "patchDigest" IS NOT NULL AND "baseSha" IS NOT NULL)
            OR ("kind" = 'publish' AND "patchDigest" IS NOT NULL AND "baseSha" IS NOT NULL AND "patchBody" IS NULL)
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
RETURNS TRIGGER AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    terminal BOOLEAN;
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
            -- A publish is the consumption of this claim's capability: no
            -- consumption, no publish; and once consumed, the claim cannot be
            -- handed back to the queue as if nothing had been reserved.
            IF OLD."kind" = 'publish' AND OLD."state" = 'claimed' AND NEW."state" IN ('published', 'queued') THEN
                PERFORM 1 FROM "EngineeringAgentCapability" c
                    WHERE c."workItemId" = OLD."id" AND c."consumedAt" IS NOT NULL
                      AND c."claimFencingToken" = OLD."fencingToken"
                    FOR UPDATE;
                IF NEW."state" = 'published' AND NOT FOUND THEN
                    RAISE EXCEPTION 'EngineeringAgentWorkItem % publishes only on a consumed capability', OLD."id"
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW."state" = 'queued' AND FOUND THEN
                    RAISE EXCEPTION 'EngineeringAgentWorkItem % consumed its capability and cannot be requeued', OLD."id"
                        USING ERRCODE = 'check_violation';
                END IF;
            END IF;
            -- A T2 decision is written first, in the same transaction, and must
            -- agree; a draft with a decision never merely expires.
            IF OLD."kind" = 't2_draft' AND NEW."state" IN ('approved', 'rejected') AND NOT EXISTS (
                SELECT 1 FROM "EngineeringAgentApproval" a
                WHERE a."workItemId" = OLD."id" AND a."decision" = NEW."state"
            ) THEN
                RAISE EXCEPTION 'EngineeringAgentWorkItem % has no matching decision', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
            IF OLD."kind" = 't2_draft' AND NEW."state" = 'expired' AND EXISTS (
                SELECT 1 FROM "EngineeringAgentApproval" a WHERE a."workItemId" = OLD."id"
            ) THEN
                RAISE EXCEPTION 'EngineeringAgentWorkItem % was decided and does not expire', OLD."id"
                    USING ERRCODE = 'check_violation';
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
$$ LANGUAGE plpgsql;

CREATE TRIGGER "engineering_agent_work_item_guard_insert"
    BEFORE INSERT ON "EngineeringAgentWorkItem"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_work_item_guard"();
CREATE TRIGGER "engineering_agent_work_item_guard_update"
    BEFORE UPDATE ON "EngineeringAgentWorkItem"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_work_item_guard"();
CREATE TRIGGER "engineering_agent_work_item_guard_delete"
    BEFORE DELETE ON "EngineeringAgentWorkItem"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_work_item_guard"();

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
RETURNS TRIGGER AS $$
DECLARE
    item RECORD;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'EngineeringAgentApproval is written once and kept' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "kind", "state", "patchDigest", "baseSha" INTO item
    FROM "EngineeringAgentWorkItem" WHERE "id" = NEW."workItemId" FOR UPDATE;
    IF NOT FOUND OR item."kind" <> 't2_draft' OR item."state" <> 'open' THEN
        RAISE EXCEPTION 'EngineeringAgentApproval decides only an open T2 draft' USING ERRCODE = 'check_violation';
    END IF;
    -- The decision binds to what the owner saw: the draft's digest and base.
    IF item."patchDigest" IS DISTINCT FROM NEW."patchDigest" OR item."baseSha" IS DISTINCT FROM NEW."baseSha" THEN
        RAISE EXCEPTION 'EngineeringAgentApproval does not match its draft' USING ERRCODE = 'check_violation';
    END IF;
    NEW."decidedAt" := clock_timestamp() AT TIME ZONE 'UTC';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "engineering_agent_approval_guard_insert"
    BEFORE INSERT ON "EngineeringAgentApproval"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_approval_guard"();
CREATE TRIGGER "engineering_agent_approval_guard_change"
    BEFORE UPDATE OR DELETE ON "EngineeringAgentApproval"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_approval_guard"();

-- By the end of the transaction that writes a decision, the draft is closed
-- as decided; a decision never sits beside an open or expired draft.
CREATE OR REPLACE FUNCTION "engineering_agent_approval_closes_draft"()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "EngineeringAgentWorkItem" w WHERE w."id" = NEW."workItemId" AND w."state" = NEW."decision"
    ) THEN
        RAISE EXCEPTION 'EngineeringAgentApproval % must close its draft as decided in the same transaction', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "engineering_agent_approval_closes_draft"
    AFTER INSERT ON "EngineeringAgentApproval"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_approval_closes_draft"();

-- ---------------------------------------------------------------------------
-- EngineeringAgentCapability: permission for one publish (§11). Issued once,
-- consumed at most once and irrevocably, immutable after.
-- ---------------------------------------------------------------------------

CREATE TABLE "EngineeringAgentCapability" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
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
    -- One capability per publish item: issuing is a single conditional write.
    ADD CONSTRAINT "EngineeringAgentCapability_workItemId_key" UNIQUE ("workItemId"),
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

ALTER TABLE "EngineeringAgentCapability"
    ADD CONSTRAINT "EngineeringAgentCapability_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "EngineeringAgentWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "engineering_agent_capability_guard"()
RETURNS TRIGGER AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    item RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'EngineeringAgentCapability is kept' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT "kind", "state", "patchDigest", "baseSha", "expectedTreeId" INTO item
        FROM "EngineeringAgentWorkItem" WHERE "id" = NEW."workItemId" FOR UPDATE;
        IF NOT FOUND OR item."kind" <> 'publish' OR item."state" <> 'queued'
            OR item."patchDigest" IS DISTINCT FROM NEW."patchDigest"
            OR item."baseSha" IS DISTINCT FROM NEW."baseSha"
            OR item."expectedTreeId" IS DISTINCT FROM NEW."expectedTreeId" THEN
            RAISE EXCEPTION 'EngineeringAgentCapability must match a queued publish item'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."consumedAt" IS NOT NULL OR NEW."expiresAt" <= now_utc THEN
            RAISE EXCEPTION 'EngineeringAgentCapability is issued unconsumed and unexpired'
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."issuedAt" := now_utc;
        RETURN NEW;
    END IF;

    IF OLD."consumedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'EngineeringAgentCapability % is consumed and immutable', OLD."id"
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
    -- The only change is consumption: once, before expiry, by the claim that
    -- holds the publish item's current fencing token.
    IF NEW."consumedAt" IS NULL THEN
        RETURN NEW;
    END IF;
    IF OLD."expiresAt" <= now_utc THEN
        RAISE EXCEPTION 'EngineeringAgentCapability % has expired', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    SELECT "state", "claimMode", "fencingToken" INTO item
    FROM "EngineeringAgentWorkItem" WHERE "id" = OLD."workItemId" FOR UPDATE;
    IF item."state" <> 'claimed' OR item."claimMode" <> 'write' OR item."fencingToken" <> NEW."claimFencingToken" THEN
        RAISE EXCEPTION 'EngineeringAgentCapability % is consumed only by the current write claim', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    NEW."consumedAt" := now_utc;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "engineering_agent_capability_guard_insert"
    BEFORE INSERT ON "EngineeringAgentCapability"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_capability_guard"();
CREATE TRIGGER "engineering_agent_capability_guard_change"
    BEFORE UPDATE OR DELETE ON "EngineeringAgentCapability"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_capability_guard"();

-- ---------------------------------------------------------------------------
-- EngineeringAgentBinding: a published pull request, as the app bound it.
-- The snapshot never changes; a replacement is a new row, and at most one
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
        CHECK ("reviewerLogin" IS NULL OR "reviewerLogin" ~ '^[A-Za-z0-9-]{1,39}$');

CREATE UNIQUE INDEX "EngineeringAgentBinding_current_prNumber_key"
    ON "EngineeringAgentBinding"("prNumber") WHERE "supersededAt" IS NULL;
CREATE INDEX "EngineeringAgentBinding_runId_idx" ON "EngineeringAgentBinding"("runId");
CREATE INDEX "EngineeringAgentBinding_state_idx" ON "EngineeringAgentBinding"("state");

ALTER TABLE "EngineeringAgentBinding"
    ADD CONSTRAINT "EngineeringAgentBinding_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "EngineeringAgentRun"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "engineering_agent_binding_guard"()
RETURNS TRIGGER AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'open' OR NEW."supersededAt" IS NOT NULL
            OR NEW."approvalObservation" IS NOT NULL OR NEW."mergeObservation" IS NOT NULL
            OR NEW."reviewerGithubId" IS NOT NULL OR NEW."reviewerLogin" IS NOT NULL OR NEW."reviewerRecordedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'EngineeringAgentBinding starts open, current and unobserved' USING ERRCODE = 'check_violation';
        END IF;
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
    IF OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt" THEN
        RAISE EXCEPTION 'EngineeringAgentBinding % was superseded', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
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
    -- A reviewer is recorded once. Retention may remove the identity; nothing
    -- may put one back or put another in its place.
    IF NEW."reviewerRecordedAt" IS DISTINCT FROM OLD."reviewerRecordedAt" THEN
        RAISE EXCEPTION 'EngineeringAgentBinding reviewerRecordedAt is written by the database'
            USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."reviewerGithubId" IS NOT NULL AND NEW."reviewerGithubId" IS DISTINCT FROM OLD."reviewerGithubId")
        OR (NEW."reviewerLogin" IS NOT NULL AND NEW."reviewerLogin" IS DISTINCT FROM OLD."reviewerLogin") THEN
        IF OLD."reviewerRecordedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'EngineeringAgentBinding % reviewer was recorded once', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."reviewerGithubId" IS NULL OR NEW."reviewerLogin" IS NULL THEN
            RAISE EXCEPTION 'EngineeringAgentBinding % reviewer is recorded whole', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."reviewerRecordedAt" := now_utc;
    END IF;
    NEW."updatedAt" := now_utc;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "engineering_agent_binding_guard_insert"
    BEFORE INSERT ON "EngineeringAgentBinding"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_binding_guard"();
CREATE TRIGGER "engineering_agent_binding_guard_change"
    BEFORE UPDATE OR DELETE ON "EngineeringAgentBinding"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_binding_guard"();

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

    CONSTRAINT "EngineeringAgentRegistration_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EngineeringAgentRegistration"
    ADD CONSTRAINT "EngineeringAgentRegistration_source_itemKey_itemDigest_key"
        UNIQUE ("source", "itemKey", "itemDigest"),
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
        CHECK (("result" = 'registered') = ("amuxCardId" IS NOT NULL));

ALTER TABLE "EngineeringAgentRegistration"
    ADD CONSTRAINT "EngineeringAgentRegistration_roundId_check" CHECK ("roundId" ~ '^[A-Za-z0-9_-]{8,64}$');

CREATE INDEX "EngineeringAgentRegistration_roundId_idx" ON "EngineeringAgentRegistration"("roundId");
CREATE INDEX "EngineeringAgentRegistration_result_createdAt_idx"
    ON "EngineeringAgentRegistration"("result", "createdAt");

ALTER TABLE "EngineeringAgentRegistration"
    ADD CONSTRAINT "EngineeringAgentRegistration_amuxCardId_fkey"
        FOREIGN KEY ("amuxCardId") REFERENCES "AmuxWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "engineering_agent_registration_guard"()
RETURNS TRIGGER AS $$
DECLARE
    -- limit: REGISTRATION_CAPS.perRound
    round_limit CONSTANT INTEGER := 3;
    -- limit: REGISTRATION_CAPS.perUtcDay
    day_limit CONSTANT INTEGER := 10;
    -- limit: REGISTRATION_CAPS.unpromoted
    unpromoted_limit CONSTANT INTEGER := 20;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."result" <> 'pending' OR NEW."decidedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'EngineeringAgentRegistration starts pending' USING ERRCODE = 'check_violation';
        END IF;
        -- The caps (policy §2.2), counted here and not only by the guard.
        -- A proposal that did not become a card -- refused, or confirmed
        -- absent -- does not count; one whose card is unknown does.
        PERFORM pg_advisory_xact_lock(hashtext('engineering-agent:registration'));
        IF (SELECT count(*) FROM "EngineeringAgentRegistration"
                WHERE "roundId" = NEW."roundId" AND "result" NOT IN ('registration_refused', 'absent')) >= round_limit THEN
            RAISE EXCEPTION 'EngineeringAgentRegistration refused: the round cap is reached' USING ERRCODE = 'check_violation';
        END IF;
        IF (SELECT count(*) FROM "EngineeringAgentRegistration"
                WHERE "createdAt" >= date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC')
                  AND "result" NOT IN ('registration_refused', 'absent')) >= day_limit THEN
            RAISE EXCEPTION 'EngineeringAgentRegistration refused: the UTC day cap is reached' USING ERRCODE = 'check_violation';
        END IF;
        IF (SELECT count(*) FROM "EngineeringAgentRegistration" r
                LEFT JOIN "AmuxWorkItem" c ON c."id" = r."amuxCardId"
                WHERE r."result" IN ('pending', 'partial')
                   OR (r."result" = 'registered' AND c."status" = 'backlog' AND c."archivedAt" IS NULL)) >= unpromoted_limit THEN
            RAISE EXCEPTION 'EngineeringAgentRegistration refused: too many registered cards wait for promotion'
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' OR OLD."result" <> 'pending' THEN
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
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'EngineeringAgentRegistration % cannot change what was proposed', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."result", NEW."result") NOT IN (
        -- transitions: EngineeringAgentRegistration registration
        ('pending', 'registered'),
        ('pending', 'registration_refused'),
        ('pending', 'absent'),
        ('pending', 'partial')
        -- end transitions
    ) THEN
        RAISE EXCEPTION 'EngineeringAgentRegistration % cannot go from % to %', OLD."id", OLD."result", NEW."result"
            USING ERRCODE = 'check_violation';
    END IF;
    NEW."decidedAt" := clock_timestamp() AT TIME ZONE 'UTC';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "engineering_agent_registration_guard_insert"
    BEFORE INSERT ON "EngineeringAgentRegistration"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_registration_guard"();
CREATE TRIGGER "engineering_agent_registration_guard_change"
    BEFORE UPDATE OR DELETE ON "EngineeringAgentRegistration"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_registration_guard"();

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
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;

CREATE TRIGGER "engineering_agent_request_guard_insert"
    BEFORE INSERT ON "EngineeringAgentRequest"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_request_guard"();
CREATE TRIGGER "engineering_agent_request_guard_change"
    BEFORE UPDATE OR DELETE ON "EngineeringAgentRequest"
    FOR EACH ROW EXECUTE FUNCTION "engineering_agent_request_guard"();

COMMIT;
