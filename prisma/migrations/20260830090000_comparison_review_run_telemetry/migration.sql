-- Content-free operational record of one AI Review run.
--
-- docs/policy/ai-review-m5-quality-contract.md §7.
--
-- Purely additive: a new table, no column is added to or removed from an
-- existing one, nothing is read or written, and every existing AI Review path
-- keeps working with the table absent (the writer treats a missing table as
-- log-only, the way lib/chatLimitDecisions.ts already does). Reversing it is
-- DROP TABLE.
--
-- Why a new table rather than columns on "ComparisonReview": that row is the
-- stored *result*, exists only for signed-in users, and only when a review
-- succeeded. Guest runs, failed runs, refusals and cache hits produce no row
-- there at all, and they are most of what a reliability number is about.
--
-- Every column is an identifier, a closed enum, a count or a timestamp. There
-- is deliberately no text column a question, an answer, a review sentence, a
-- quote or a filename could be written into.
CREATE TABLE "ComparisonReviewRun" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "userId" TEXT,
    "conversationId" TEXT,
    "reviewMode" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "responseCount" INTEGER NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "dualReviewRequested" BOOLEAN NOT NULL DEFAULT false,
    "dualReviewAvailable" BOOLEAN NOT NULL DEFAULT false,
    "dualReviewCompleted" BOOLEAN NOT NULL DEFAULT false,
    "crossProvider" BOOLEAN,
    "primaryModelId" TEXT,
    "primaryProvider" TEXT,
    "primaryStatus" TEXT NOT NULL,
    "primaryDurationMs" INTEGER,
    "primaryErrorCode" TEXT,
    "primaryErrorCategory" TEXT,
    "primaryInputTokens" INTEGER NOT NULL DEFAULT 0,
    "primaryOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "primaryReservedCredits" INTEGER NOT NULL DEFAULT 0,
    "primarySettlementStatus" TEXT,
    "primaryRetryCount" INTEGER NOT NULL DEFAULT 0,
    "secondaryModelId" TEXT,
    "secondaryProvider" TEXT,
    "secondaryStatus" TEXT NOT NULL,
    "secondaryDurationMs" INTEGER,
    "secondaryErrorCode" TEXT,
    "secondaryErrorCategory" TEXT,
    "secondaryInputTokens" INTEGER NOT NULL DEFAULT 0,
    "secondaryOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "secondaryReservedCredits" INTEGER NOT NULL DEFAULT 0,
    "secondarySettlementStatus" TEXT,
    "secondaryRetryCount" INTEGER NOT NULL DEFAULT 0,
    "groundingTotalQuotes" INTEGER NOT NULL DEFAULT 0,
    "groundingMatchedQuotes" INTEGER NOT NULL DEFAULT 0,
    "sourceGroundingLevel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComparisonReviewRun_pkey" PRIMARY KEY ("id")
);

-- No foreign key to "User". The same decision "ChatLimitDecisionEvent" makes,
-- for the same reason: a guest run has no user at all, and a cascade would
-- delete the operational history that a reliability trend is computed from.
-- Account deletion anonymises these rows instead, through
-- lib/accountDataAnonymisation.ts, and the 90-day purge removes them.
CREATE INDEX "ComparisonReviewRun_createdAt_idx" ON "ComparisonReviewRun"("createdAt");
CREATE INDEX "ComparisonReviewRun_outcome_createdAt_idx" ON "ComparisonReviewRun"("outcome", "createdAt");
CREATE INDEX "ComparisonReviewRun_userId_createdAt_idx" ON "ComparisonReviewRun"("userId", "createdAt");
CREATE INDEX "ComparisonReviewRun_subjectKey_createdAt_idx" ON "ComparisonReviewRun"("subjectKey", "createdAt");
CREATE INDEX "ComparisonReviewRun_traceId_idx" ON "ComparisonReviewRun"("traceId");
