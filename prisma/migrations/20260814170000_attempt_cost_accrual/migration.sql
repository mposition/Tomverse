-- Provider cost that survives the process that incurred it.
--
-- Until now `ChatAttemptUsage` was created in settlement and nowhere else, so
-- a process that died after dispatching left no cost row and no rollup: the
-- provider was called, was paid, and the ledger never heard about it. §7 says
-- a goodwill refund "must not rewrite provider cost accounting"; losing the
-- accounting outright is worse than rewriting it.
--
-- Three things make it recordable. The cost row gains the provenance to say
-- how it knows what it knows; the outcome list gains the one a crash produces;
-- and corrections get their own append-only ledger, because a late actual must
-- not overwrite the estimate it corrects.

-- How the numbers on a cost row were arrived at.
--
-- Explicit columns rather than free text inside `pricingSnapshot`, because
-- these are read by reports that have to separate measured spend from
-- estimated spend. A provenance nobody can filter on is a provenance nobody
-- uses.
ALTER TABLE "ChatAttemptUsage" ADD COLUMN "usageSource" TEXT NOT NULL DEFAULT 'provider_usage_metadata';
ALTER TABLE "ChatAttemptUsage" ADD COLUMN "costSource" TEXT NOT NULL DEFAULT 'token_estimate';

ALTER TABLE "ChatAttemptUsage"
    ADD CONSTRAINT "ChatAttemptUsage_usageSource_check"
    CHECK (
        "usageSource" IN (
            -- The provider reported token counts for this call.
            'provider_usage_metadata',
            -- The provider reported a cost for this call.
            'provider_response_cost',
            -- No usage metadata arrived; the documented estimator was used.
            'fallback_estimator',
            -- Nobody observed this call. The sweep wrote what was reserved.
            'crash_reconciliation'
        )
    );

ALTER TABLE "ChatAttemptUsage"
    ADD CONSTRAINT "ChatAttemptUsage_costSource_check"
    CHECK (
        "costSource" IN (
            'token_estimate',
            'provider_response',
            -- An upper bound, not a measurement. What the attempt was
            -- authorized to spend, recorded because the call happened and 0
            -- would be a claim that it did not.
            'reserved_upper_bound'
        )
    );

-- A crash-reconciled row knows nothing about tokens, and 0 would say it does.
-- NULL is the honest value, so the columns stop being NOT NULL.
--
-- The default goes with the NOT NULL. A column that is nullable but defaults
-- to 0 would answer "unknown" with "zero" for every writer that omits it,
-- which is the exact substitution the nullability exists to prevent.
ALTER TABLE "ChatAttemptUsage" ALTER COLUMN "inputTokens" DROP NOT NULL;
ALTER TABLE "ChatAttemptUsage" ALTER COLUMN "inputTokens" DROP DEFAULT;
ALTER TABLE "ChatAttemptUsage" ALTER COLUMN "cachedInputTokens" DROP NOT NULL;
ALTER TABLE "ChatAttemptUsage" ALTER COLUMN "cachedInputTokens" DROP DEFAULT;
ALTER TABLE "ChatAttemptUsage" ALTER COLUMN "outputTokens" DROP NOT NULL;
ALTER TABLE "ChatAttemptUsage" ALTER COLUMN "outputTokens" DROP DEFAULT;

ALTER TABLE "ChatAttemptUsage" DROP CONSTRAINT "ChatAttemptUsage_nonnegative_check";
ALTER TABLE "ChatAttemptUsage"
    ADD CONSTRAINT "ChatAttemptUsage_nonnegative_check"
    CHECK (
        ("inputTokens" IS NULL OR "inputTokens" >= 0)
        AND ("cachedInputTokens" IS NULL OR "cachedInputTokens" >= 0)
        AND (
            "cachedInputTokens" IS NULL
            OR "inputTokens" IS NULL
            OR "cachedInputTokens" <= "inputTokens"
        )
        AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
        AND ("reasoningTokens" IS NULL OR "reasoningTokens" >= 0)
        AND "costMicroUsd" >= 0
    );

-- Only a crash-reconciled row may leave the token counts unknown. Every other
-- provenance had something to count.
ALTER TABLE "ChatAttemptUsage"
    ADD CONSTRAINT "ChatAttemptUsage_unknown_tokens_check"
    CHECK (
        "usageSource" = 'crash_reconciliation'
        OR ("inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL)
    );

-- The outcome a crash produces, matching RoutingAttempt's own vocabulary.
ALTER TABLE "ChatAttemptUsage" DROP CONSTRAINT "ChatAttemptUsage_outcome_check";
ALTER TABLE "ChatAttemptUsage"
    ADD CONSTRAINT "ChatAttemptUsage_outcome_check"
    CHECK (
        "outcome" IN (
            'completed',
            'cancelled',
            'failed',
            'empty',
            -- Recorded by the sweep. `failed` would be a claim about a
            -- provider call nobody observed.
            'unknown_after_dispatch'
        )
    );

-- Corrections, appended, never applied in place.
--
-- A crash-reconciled row is an upper bound written because the call happened.
-- Real usage can still arrive afterwards -- a delayed settlement, a provider
-- reconciliation file -- and the unique key on (reservationId, attemptIndex)
-- means a second insert is silently skipped. Silently is the problem: the
-- estimate would stand for ever while the truth was known and discarded.
--
-- So the base row stays immutable and the observation lands here, with the
-- signed difference it makes. Resolved provider cost is base plus its
-- adjustments; nothing has to be rewritten for that to be true.
CREATE TABLE "ChatAttemptUsageAdjustment" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "attemptIndex" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    -- What the observation itself said, in its own terms.
    "observedInputTokens" INTEGER,
    "observedCachedInputTokens" INTEGER,
    "observedOutputTokens" INTEGER,
    "observedCostMicroUsd" BIGINT NOT NULL,
    -- Signed: observed minus what the base row already claimed.
    "costDeltaMicroUsd" BIGINT NOT NULL,
    -- Identifies the observation, so the same one twice is one adjustment.
    "observationId" TEXT NOT NULL,
    "providerRequestId" TEXT,
    -- Whether the delta has been folded into ProviderDailyUsage yet.
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatAttemptUsageAdjustment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChatAttemptUsageAdjustment"
    ADD CONSTRAINT "ChatAttemptUsageAdjustment_attempt_fkey"
    FOREIGN KEY ("reservationId", "attemptIndex")
    REFERENCES "ChatAttemptUsage" ("reservationId", "attemptIndex")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- One adjustment per observation. A provider reconciliation file replayed
-- twice must move the ledger once.
CREATE UNIQUE INDEX "ChatAttemptUsageAdjustment_observation_key"
    ON "ChatAttemptUsageAdjustment" ("reservationId", "attemptIndex", "observationId");

ALTER TABLE "ChatAttemptUsageAdjustment"
    ADD CONSTRAINT "ChatAttemptUsageAdjustment_kind_check"
    CHECK ("kind" IN ('late_provider_actual'));

CREATE INDEX "ChatAttemptUsageAdjustment_unapplied_idx"
    ON "ChatAttemptUsageAdjustment" ("createdAt")
    WHERE "appliedAt" IS NULL;

-- Same rule as the row it corrects: written once, never edited. `appliedAt`
-- is the one exception, and only NULL to a value -- the same shape of door as
-- the manifest's compaction.
CREATE OR REPLACE FUNCTION "chat_attempt_usage_adjustment_is_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT (
        OLD."appliedAt" IS NULL
        AND NEW."appliedAt" IS NOT NULL
        AND NEW."id" = OLD."id"
        AND NEW."reservationId" = OLD."reservationId"
        AND NEW."attemptIndex" = OLD."attemptIndex"
        AND NEW."kind" = OLD."kind"
        AND NEW."observedCostMicroUsd" = OLD."observedCostMicroUsd"
        AND NEW."costDeltaMicroUsd" = OLD."costDeltaMicroUsd"
        AND NEW."observationId" = OLD."observationId"
        AND NEW."createdAt" = OLD."createdAt"
    ) THEN
        RAISE EXCEPTION
            'ChatAttemptUsageAdjustment % is append-only; only appliedAt may be set once', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chat_attempt_usage_adjustment_is_append_only"
    BEFORE UPDATE ON "ChatAttemptUsageAdjustment"
    FOR EACH ROW
    EXECUTE FUNCTION "chat_attempt_usage_adjustment_is_append_only"();

-- A refunded reservation may name no attempt.
--
-- The previous version required a settlement pointer whenever attempt cost
-- rows existed. Crash reconciliation breaks that: the user is refunded in
-- full, the provider cost is kept, and no attempt was used as the basis of a
-- charge. NULL is then the honest value, and demanding one would force a
-- claim that some attempt was billed when none was.
CREATE OR REPLACE FUNCTION "chat_reservation_settled_names_its_attempt"()
RETURNS TRIGGER AS $$
DECLARE
    current_status TEXT;
    current_pointer INTEGER;
    current_credits INTEGER;
    attempt_count INTEGER;
BEGIN
    SELECT "status", "settlementAttemptIndex", "settledCredits"
    INTO current_status, current_pointer, current_credits
    FROM "ChatCreditReservation"
    WHERE "id" = NEW."id";

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Only a settlement that actually charged the user has to say which
    -- attempt it charged for. A full refund charged for none.
    IF current_status = 'settled'
       AND COALESCE(current_credits, 0) > 0
       AND current_pointer IS NULL THEN
        SELECT COUNT(*) INTO attempt_count
        FROM "ChatAttemptUsage"
        WHERE "reservationId" = NEW."id";
        IF attempt_count > 0 THEN
            RAISE EXCEPTION
                'ChatCreditReservation % charged % credits across % attempt(s) and names none',
                NEW."id", current_credits, attempt_count
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
