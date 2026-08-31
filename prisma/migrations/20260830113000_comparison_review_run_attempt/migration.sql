-- One row per provider attempt inside an AI Review run.
--
-- docs/policy/ai-review-m5-quality-contract.md §7.
--
-- The defect this closes: `ComparisonReviewRun` carries two attempt slots, and
-- the recorder overwrote its primary slot with each candidate it tried. A run
-- where the first reviewer failed and the second succeeded therefore recorded
-- only the success -- so the reviewer failure rates that an M5 judgement reads
-- came out better than production actually was, and a fallback looked like a
-- clean run.
--
-- The run row is NOT redundant with this table and is left alone. It answers
-- "which reviewer produced the result the user saw"; this answers "what
-- actually happened". Neither derives the other.
--
-- Purely additive: a new table, no existing column touched, nothing read or
-- written. Reversing it is DROP TABLE, and the run rows keep working with it
-- absent (the writer treats a missing table as log-only).
--
-- Every column is an identifier, a closed enum, a count or a timestamp; there
-- is no text column a question, an answer, a review sentence or a quote could
-- be written into.
--
-- Deliberately no reservation id. An over-settlement is traced through the
-- run's own traceId, which credit reservations already carry -- and which the
-- account-deletion path already anonymises. A second join key would have been
-- a second identifier to scrub, on a table the data-domain registry cannot
-- hold a row for (it reaches the person only through its run, and the
-- registry derives its set from user columns and relations).
CREATE TABLE "ComparisonReviewRunAttempt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "slot" TEXT NOT NULL,
    "reviewerModelId" TEXT NOT NULL,
    "reviewerProvider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorCategory" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reservedCredits" INTEGER NOT NULL DEFAULT 0,
    -- Nullable on purpose. NULL means settlement did not run or did not
    -- report; 0 means it ran and charged nothing. A reconciliation that could
    -- not tell those apart would read every unsettled attempt as a refund.
    "settledCredits" INTEGER,
    "settlementStatus" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComparisonReviewRunAttempt_pkey" PRIMARY KEY ("id")
);

-- The ordinal is the order candidates were tried, and it is unique per run:
-- that is what makes "the second attempt" a thing one can name, and what stops
-- a retry of the writer from doubling a run's attempt count.
CREATE UNIQUE INDEX "ComparisonReviewRunAttempt_runId_ordinal_key"
    ON "ComparisonReviewRunAttempt"("runId", "ordinal");
CREATE INDEX "ComparisonReviewRunAttempt_reviewerModelId_createdAt_idx"
    ON "ComparisonReviewRunAttempt"("reviewerModelId", "createdAt");
CREATE INDEX "ComparisonReviewRunAttempt_status_createdAt_idx"
    ON "ComparisonReviewRunAttempt"("status", "createdAt");
CREATE INDEX "ComparisonReviewRunAttempt_createdAt_idx"
    ON "ComparisonReviewRunAttempt"("createdAt");

-- Cascades with its run, which is what makes the 90-day purge and the
-- account-deletion path reach these rows without either of them being taught
-- about a second table.
ALTER TABLE "ComparisonReviewRunAttempt"
    ADD CONSTRAINT "ComparisonReviewRunAttempt_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "ComparisonReviewRun"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
