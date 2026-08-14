-- What each dispatched attempt cost, at its own provider's rates.
--
-- Expand-only and additive. Every turn so far dispatched once, and a
-- single-attempt turn writes no row here: the reservation already tells its
-- whole story. Rows appear only when a turn dispatches more than once.

CREATE TABLE "ChatAttemptUsage" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "attemptIndex" INTEGER NOT NULL,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "userBilled" BOOLEAN NOT NULL DEFAULT false,
    "providerRequestId" TEXT,
    "providerResponseId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "pricingSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatAttemptUsage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChatAttemptUsage"
    ADD CONSTRAINT "ChatAttemptUsage_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "ChatCreditReservation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- §5 numbers attempts within a run from 0. Two rows under one index would
-- mean one attempt's cost silently replaced another's, which is the exact
-- failure this table exists to prevent.
CREATE UNIQUE INDEX "ChatAttemptUsage_reservationId_attemptIndex_key"
    ON "ChatAttemptUsage" ("reservationId", "attemptIndex");

-- "Exactly one end-user settlement", as a constraint rather than a promise.
-- Partial, so the many not-billed attempts do not collide with each other:
-- what is unique is the billed one, per reservation.
CREATE UNIQUE INDEX "ChatAttemptUsage_one_billed_attempt_idx"
    ON "ChatAttemptUsage" ("reservationId")
    WHERE "userBilled";

-- The outcomes an attempt can end with. Same four words settleChatUsage
-- already writes to ChatCreditReservation.outcome, deliberately -- a second
-- vocabulary for the same fact is how two reports about one turn disagree.
ALTER TABLE "ChatAttemptUsage"
    ADD CONSTRAINT "ChatAttemptUsage_outcome_check"
    CHECK ("outcome" IN ('completed', 'cancelled', 'failed', 'empty'));

-- §6's two-build budget, at the only layer that sees the money. A third
-- attempt is not a rounding problem, it is a policy breach, and it should be
-- impossible to record rather than merely reported later.
ALTER TABLE "ChatAttemptUsage"
    ADD CONSTRAINT "ChatAttemptUsage_attemptIndex_check"
    CHECK ("attemptIndex" >= 0 AND "attemptIndex" <= 1);

-- Costs and token counts are quantities, not signed adjustments. A negative
-- one here would be a refund hiding inside an audit row.
ALTER TABLE "ChatAttemptUsage"
    ADD CONSTRAINT "ChatAttemptUsage_nonnegative_check"
    CHECK (
        "inputTokens" >= 0
        AND "cachedInputTokens" >= 0
        AND "cachedInputTokens" <= "inputTokens"
        AND "outputTokens" >= 0
        AND ("reasoningTokens" IS NULL OR "reasoningTokens" >= 0)
        AND "costMicroUsd" >= 0
    );

-- An attempt's cost is what it cost. Rewriting one after the fact is how a
-- goodwill refund ends up "rewriting provider cost accounting", which §7
-- forbids in those words -- so the row admits no update at all. A correction
-- is a new record elsewhere, not a quiet edit to the evidence.
CREATE OR REPLACE FUNCTION "chat_attempt_usage_is_immutable"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'ChatAttemptUsage % records what one attempt cost and cannot be modified', OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chat_attempt_usage_is_immutable"
    BEFORE UPDATE ON "ChatAttemptUsage"
    FOR EACH ROW
    EXECUTE FUNCTION "chat_attempt_usage_is_immutable"();

CREATE INDEX "ChatAttemptUsage_provider_createdAt_idx"
    ON "ChatAttemptUsage" ("provider", "createdAt");

CREATE INDEX "ChatAttemptUsage_providerRequestId_idx"
    ON "ChatAttemptUsage" ("providerRequestId");
