-- Support-triage suggestion (docs/policy/support-triage.md §1, §2, §5, §6).
--
-- One row per (report, input digest): a new digest makes a new row. The row
-- carries a proposed lane and keyword-flag codes only -- never the report's
-- text. This migration writes no row.
--
-- What the database enforces:
--
--   * a row is born pending, unclaimed, unqueued, with no lane and no failure;
--   * the state moves only along the transitions block below, and a terminal
--     row never changes again;
--   * claiming stamps the lease from the database clock (5 minutes); only an
--     expired lease can be reclaimed, and a reclaim clears the claim token and
--     counts the attempt, at most three -- the fourth must fail instead;
--   * leaving `claimed` clears the claim token and lease;
--   * the report, the input digest and the creation time are immutable;
--   * displayed is a separate column, reachable only from not_queued on a
--     ready row, and stamped by the database.
--
-- Time is the database's: clock_timestamp() AT TIME ZONE 'UTC', read once per
-- trigger call. The trigger pins search_path and has no EXCEPTION handler.

BEGIN;

CREATE TABLE "SupportTriageSuggestion" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "failureCode" TEXT,
    "claimToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lane" TEXT,
    "keywordFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ownerQueueState" TEXT NOT NULL DEFAULT 'not_queued',
    "displayedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTriageSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportTriageSuggestion_feedbackId_inputDigest_key" ON "SupportTriageSuggestion"("feedbackId", "inputDigest");

CREATE INDEX "SupportTriageSuggestion_state_ownerQueueState_createdAt_idx" ON "SupportTriageSuggestion"("state", "ownerQueueState", "createdAt");

CREATE INDEX "SupportTriageSuggestion_leaseExpiresAt_idx" ON "SupportTriageSuggestion"("leaseExpiresAt");

ALTER TABLE "SupportTriageSuggestion" ADD CONSTRAINT "SupportTriageSuggestion_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "SupportTriageSuggestion"
    ADD CONSTRAINT "SupportTriageSuggestion_state_check"
        CHECK ("state" IN ('pending', 'claimed', 'ready', 'accepted', 'rejected', 'expired', 'superseded', 'invalidated', 'failed')),
    ADD CONSTRAINT "SupportTriageSuggestion_failureCode_check"
        CHECK ("failureCode" IS NULL OR "failureCode" IN ('config_error', 'internal_error', 'retry_exhausted')),
    ADD CONSTRAINT "SupportTriageSuggestion_lane_check"
        CHECK ("lane" IS NULL OR "lane" IN ('bug_verified', 'bug_unverified', 'billing_human', 'trust_safety_human', 'feature_request', 'other')),
    ADD CONSTRAINT "SupportTriageSuggestion_ownerQueueState_check"
        CHECK ("ownerQueueState" IN ('not_queued', 'displayed')),
    ADD CONSTRAINT "SupportTriageSuggestion_inputDigest_check"
        CHECK ("inputDigest" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "SupportTriageSuggestion_keywordFlags_check"
        CHECK ("keywordFlags" IS NOT NULL
               AND "keywordFlags" <@ ARRAY['money', 'account_privacy', 'security', 'legal', 'self_harm_threat']::TEXT[]),
    ADD CONSTRAINT "SupportTriageSuggestion_attemptCount_check"
        CHECK ("attemptCount" BETWEEN 0 AND 3),
    -- A claimed row holds a token and a lease; no other row does.
    ADD CONSTRAINT "SupportTriageSuggestion_claim_check"
        CHECK (("state" = 'claimed') = ("claimToken" IS NOT NULL)
               AND ("state" = 'claimed') = ("leaseExpiresAt" IS NOT NULL)),
    ADD CONSTRAINT "SupportTriageSuggestion_failure_check"
        CHECK (("state" = 'failed') = ("failureCode" IS NOT NULL)),
    -- A proposal that reached ready names its lane, and keeps it. An expired
    -- row may never have been ready, so it may have none.
    ADD CONSTRAINT "SupportTriageSuggestion_lane_present_check"
        CHECK ("state" NOT IN ('ready', 'accepted', 'rejected') OR "lane" IS NOT NULL),
    ADD CONSTRAINT "SupportTriageSuggestion_displayed_check"
        CHECK (("ownerQueueState" = 'displayed') = ("displayedAt" IS NOT NULL));

CREATE OR REPLACE FUNCTION "support_triage_suggestion_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    -- limit: SUGGESTION_LEASE_SECONDS
    lease CONSTANT INTERVAL := interval '5 minutes';
    -- The message lib/accountDeletion.ts leaves on a deleted account's report.
    deleted_marker CONSTANT TEXT := '[deleted account]';
    report_message TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'pending' OR NEW."claimToken" IS NOT NULL OR NEW."leaseExpiresAt" IS NOT NULL
            OR NEW."attemptCount" <> 0 OR NEW."ownerQueueState" <> 'not_queued'
            OR NEW."displayedAt" IS NOT NULL OR NEW."failureCode" IS NOT NULL OR NEW."lane" IS NOT NULL
            OR NEW."keywordFlags" IS DISTINCT FROM ARRAY[]::TEXT[] THEN
            RAISE EXCEPTION 'SupportTriageSuggestion must be inserted pending and unclaimed'
                USING ERRCODE = 'check_violation';
        END IF;
        -- Nothing is derived again from a deleted account's report. The row
        -- is locked so an account deletion cannot slip in between.
        EXECUTE pg_catalog.format(
            'SELECT f."message" FROM %I."Feedback" f WHERE f."id" = $1 FOR SHARE',
            TG_TABLE_SCHEMA
        ) INTO report_message USING NEW."feedbackId";
        IF report_message = deleted_marker THEN
            RAISE EXCEPTION 'SupportTriageSuggestion cannot be created for a deleted account''s report'
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."createdAt" := now_utc;
        NEW."updatedAt" := now_utc;
        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."feedbackId" IS DISTINCT FROM OLD."feedbackId"
        OR NEW."inputDigest" IS DISTINCT FROM OLD."inputDigest"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'SupportTriageSuggestion report, input digest and creation time are immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" IN ('accepted', 'rejected', 'expired', 'superseded', 'invalidated', 'failed') THEN
        RAISE EXCEPTION 'SupportTriageSuggestion % is terminal', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."state" IS DISTINCT FROM OLD."state" THEN
        IF (OLD."state", NEW."state") NOT IN (
            -- transitions: SupportTriageSuggestion state
            ('pending', 'claimed'),
            ('claimed', 'pending'),
            ('claimed', 'ready'),
            ('claimed', 'failed'),
            ('ready', 'accepted'),
            ('ready', 'rejected'),
            ('ready', 'expired'),
            ('ready', 'superseded'),
            ('ready', 'invalidated'),
            ('pending', 'superseded'),
            ('claimed', 'superseded'),
            ('pending', 'invalidated'),
            ('claimed', 'invalidated'),
            ('pending', 'expired'),
            ('claimed', 'expired')
            -- end transitions
        ) THEN
            RAISE EXCEPTION 'SupportTriageSuggestion % cannot go from % to %', OLD."id", OLD."state", NEW."state"
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW."state" = 'claimed' THEN
            -- The caller brings the token; the database sets the lease.
            NEW."leaseExpiresAt" := now_utc + lease;
            NEW."attemptCount" := OLD."attemptCount";
        ELSIF OLD."state" = 'claimed' AND NEW."state" = 'pending' THEN
            -- Only an expired lease is reclaimed, and the attempt is counted.
            IF OLD."leaseExpiresAt" > now_utc THEN
                RAISE EXCEPTION 'SupportTriageSuggestion % lease has not expired', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
            NEW."claimToken" := NULL;
            NEW."leaseExpiresAt" := NULL;
            NEW."attemptCount" := OLD."attemptCount" + 1;
        ELSIF OLD."state" = 'claimed' THEN
            NEW."claimToken" := NULL;
            NEW."leaseExpiresAt" := NULL;
            NEW."attemptCount" := OLD."attemptCount";
        ELSE
            NEW."attemptCount" := OLD."attemptCount";
        END IF;
    ELSE
        -- Without a state change, the claim fields and the attempt count stay put.
        IF NEW."claimToken" IS DISTINCT FROM OLD."claimToken"
            OR NEW."leaseExpiresAt" IS DISTINCT FROM OLD."leaseExpiresAt"
            OR NEW."attemptCount" IS DISTINCT FROM OLD."attemptCount" THEN
            RAISE EXCEPTION 'SupportTriageSuggestion claim fields change only with the state'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- The proposal is written once, by the result that makes the row ready.
    IF (NEW."lane" IS DISTINCT FROM OLD."lane" OR NEW."keywordFlags" IS DISTINCT FROM OLD."keywordFlags")
        AND NOT (OLD."state" = 'claimed' AND NEW."state" = 'ready') THEN
        RAISE EXCEPTION 'SupportTriageSuggestion % lane and flags are written only on becoming ready', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    -- A CHECK cannot see inside the array: no NULL element, no repeat.
    IF pg_catalog.array_position(NEW."keywordFlags", NULL) IS NOT NULL
        OR pg_catalog.cardinality(NEW."keywordFlags")
           <> (SELECT pg_catalog.count(DISTINCT flag) FROM pg_catalog.unnest(NEW."keywordFlags") AS flag) THEN
        RAISE EXCEPTION 'SupportTriageSuggestion keywordFlags must be distinct, non-null codes'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."ownerQueueState" IS DISTINCT FROM OLD."ownerQueueState" THEN
        -- Displaying is its own write on an already-ready row, never part of
        -- the result that makes it ready: promotion is capped separately.
        IF NOT (OLD."ownerQueueState" = 'not_queued' AND NEW."ownerQueueState" = 'displayed'
                AND OLD."state" = 'ready' AND NEW."state" = 'ready') THEN
            RAISE EXCEPTION 'SupportTriageSuggestion % can be displayed only once, while ready', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."displayedAt" := now_utc;
    ELSIF NEW."displayedAt" IS DISTINCT FROM OLD."displayedAt" THEN
        RAISE EXCEPTION 'SupportTriageSuggestion displayedAt is written by the database'
            USING ERRCODE = 'check_violation';
    END IF;

    NEW."updatedAt" := now_utc;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SupportTriageSuggestion_guard"
    BEFORE INSERT OR UPDATE ON "SupportTriageSuggestion"
    FOR EACH ROW EXECUTE FUNCTION "support_triage_suggestion_guard"();

COMMIT;
