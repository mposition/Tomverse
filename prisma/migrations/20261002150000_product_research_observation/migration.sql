-- The product-research agent's observation table
-- (docs/policy/product-research-agent.md §4).
--
-- One table, no user content beyond normalised public issue titles, one writer
-- (lib/productResearchObservationStore.ts, enforced by
-- scripts/check-protected-table-writers-core.mjs). This migration writes no row
-- and turns nothing on: both switches are unset until an operator sets them.
--
-- Three things the database owns, because the application cannot be the only
-- thing holding them:
--
--   1. One row per scheduled slot. A unique constraint, not a check-then-insert
--      -- two runs of the same slot (a retried cron, an operator running the
--      service by hand) would otherwise both read "no row yet" and both write.
--
--   2. A late run is not recorded as a success (common foundation §6.2a). The
--      insert trigger compares the database's own clock against the slot's
--      one-hour window and refuses outside it. A run whose own clock has
--      drifted, or which hung past its window and submitted anyway, produces
--      no row -- and no row is what the silence check is for.
--
--   3. The row never changes and is not deleted early. Updates are refused
--      outright; a delete is refused until the row is older than the retention
--      period, with no exception for the newest row.
--
-- The trigger function pins search_path to pg_catalog, pg_temp and reads
-- nothing else, so a session's temporary table cannot stand in for the real
-- one.

BEGIN;

CREATE TABLE "ProductResearchObservation" (
    "id" TEXT NOT NULL,
    "slot" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT NOT NULL,
    "failureStage" TEXT,
    "schemaVersion" INTEGER NOT NULL,
    "developSha" TEXT,
    "mainSha" TEXT,
    "issueCount" INTEGER,
    "payload" JSONB,
    "payloadDigest" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductResearchObservation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProductResearchObservation"
    ADD CONSTRAINT "ProductResearchObservation_slot_key" UNIQUE ("slot"),
    ADD CONSTRAINT "ProductResearchObservation_id_check" CHECK ("id" ~ '^[0-9a-z_-]{1,64}$'),
    -- The slot is a scheduled instant, so it lands on a whole minute. A slot
    -- carrying seconds is a submitter that invented one from its own clock
    -- rather than deriving it, and then "one row per slot" means nothing.
    ADD CONSTRAINT "ProductResearchObservation_slot_whole_minute_check"
        CHECK (date_trunc('minute', "slot") = "slot"),
    ADD CONSTRAINT "ProductResearchObservation_outcome_check"
        CHECK ("outcome" IN ('ok', 'failed')),
    -- stages: OBSERVATION_FAILURE_STAGES
    ADD CONSTRAINT "ProductResearchObservation_failureStage_check"
        CHECK ("failureStage" IS NULL OR "failureStage" IN (
            'clone_failed',
            'release_branch_unavailable',
            'issue_fetch_failed',
            'issue_input_too_large',
            'issue_backlog_failed',
            'schema_invalid',
            'set_mismatch',
            'count_mismatch',
            'row_count_exceeded',
            'timeout'
        )),
    -- version: OBSERVATION_SCHEMA_VERSION
    ADD CONSTRAINT "ProductResearchObservation_schemaVersion_check"
        CHECK ("schemaVersion" = 1),
    ADD CONSTRAINT "ProductResearchObservation_developSha_check"
        CHECK ("developSha" IS NULL OR "developSha" ~ '^[0-9a-f]{40}$'),
    ADD CONSTRAINT "ProductResearchObservation_mainSha_check"
        CHECK ("mainSha" IS NULL OR "mainSha" ~ '^[0-9a-f]{40}$'),
    -- limit: OBSERVATION_ROW_LIMIT
    ADD CONSTRAINT "ProductResearchObservation_issueCount_check"
        CHECK ("issueCount" IS NULL OR ("issueCount" >= 0 AND "issueCount" <= 200)),
    ADD CONSTRAINT "ProductResearchObservation_payloadDigest_check"
        CHECK ("payloadDigest" IS NULL OR "payloadDigest" ~ '^[0-9a-f]{64}$'),
    -- A successful slot carries everything a reader needs to recompute its own
    -- summary: both pinned commits, the rows, the count and the digest. A
    -- failed slot carries none of it, which is the rule that keeps a failure
    -- from displaying an earlier success's content.
    ADD CONSTRAINT "ProductResearchObservation_outcome_shape_check"
        CHECK (
            ("outcome" = 'ok'
                AND "failureStage" IS NULL
                AND "developSha" IS NOT NULL
                AND "mainSha" IS NOT NULL
                AND "issueCount" IS NOT NULL
                AND "payload" IS NOT NULL
                AND "payloadDigest" IS NOT NULL)
            OR ("outcome" = 'failed'
                AND "failureStage" IS NOT NULL
                AND "issueCount" IS NULL
                AND "payload" IS NULL
                AND "payloadDigest" IS NULL)
        );

CREATE INDEX "ProductResearchObservation_outcome_slot_idx"
    ON "ProductResearchObservation"("outcome", "slot");
CREATE INDEX "ProductResearchObservation_submittedAt_idx"
    ON "ProductResearchObservation"("submittedAt");

CREATE OR REPLACE FUNCTION "product_research_observation_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    -- window: SLOT_WINDOW_MS
    slot_window CONSTANT INTERVAL := INTERVAL '1 hour';
    -- retention: OBSERVATION_RETENTION_DAYS
    retention CONSTANT INTERVAL := INTERVAL '90 days';
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- There is nothing to correct. A slot's answer is what the run found;
        -- a later edit would make the stored row say something no run ever
        -- observed, and the row is the only record of the observation.
        RAISE EXCEPTION 'ProductResearchObservation is insert-only'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD."submittedAt" > now_utc - retention THEN
            RAISE EXCEPTION 'ProductResearchObservation is kept for its retention period'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    -- INSERT. The window is closed at its end: a run that reaches the next
    -- slot's instant is answering for a slot that is no longer its own.
    IF now_utc < NEW."slot" THEN
        RAISE EXCEPTION 'ProductResearchObservation slot has not started'
            USING ERRCODE = 'check_violation';
    END IF;
    IF now_utc >= NEW."slot" + slot_window THEN
        RAISE EXCEPTION 'ProductResearchObservation slot window has passed'
            USING ERRCODE = 'check_violation';
    END IF;
    -- submittedAt is the database's, not the submitter's: a submitter that
    -- could set it could place a row inside a window it missed, and could move
    -- a row out of reach of the retention sweep.
    NEW."submittedAt" := now_utc;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "product_research_observation_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "ProductResearchObservation"
    FOR EACH ROW EXECUTE FUNCTION "product_research_observation_guard"();

COMMIT;
