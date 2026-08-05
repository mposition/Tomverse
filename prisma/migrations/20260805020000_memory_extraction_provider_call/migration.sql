-- Release B slice 1.6 (policy §3, §11): operational provider-cost accounting
-- for memory extraction, per actual provider call.
--
-- This is a DIFFERENT layer from the run's user-credit reservation, and the
-- difference is the reason the table exists. User credits are reserved once
-- per run and settled at a terminal state, charging only the chunks that
-- completed — a chunk that failed is refunded to the user, because they did
-- not get it. But if the request was actually issued, the provider may well
-- have billed for it, and erasing that from the provider budget would let a
-- run that keeps failing consume an unbounded amount of a budget that reads
-- as untouched.
--
-- One row per (chunk, attempt), which is the unit a provider call happens in.
-- `callIssued` is written BEFORE the request leaves, so a crash mid-flight is
-- recoverable as "may have cost something" rather than as "nothing happened".
CREATE TABLE "MemoryExtractionProviderCall" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,

    -- True once the request has been handed to the provider. The point of no
    -- return for operational cost.
    "callIssued" BOOLEAN NOT NULL DEFAULT false,
    -- Micro-USD consumed from the provider and extraction sub-budget buckets
    -- when the attempt was admitted. Released in full only if no call went out.
    "reservedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    -- What the call actually cost, once usage is known. NULL while unknown,
    -- which is why the reservation is the conservative charge until then.
    "settledCostMicroUsd" BIGINT,
    -- False when the provider reported no usage: the reservation stands rather
    -- than the call being recorded as free.
    "usageConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    -- Provider-side response id, for reconciling a charge we cannot confirm.
    "responseId" TEXT,
    "failureCode" TEXT,

    "startedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryExtractionProviderCall_pkey" PRIMARY KEY ("id")
);

-- The identity the policy names: (runId, chunkIndex, attemptCount), expressed
-- through the chunk row that already carries (runId, chunkIndex). A replayed
-- attempt collides here instead of consuming the budget twice.
CREATE UNIQUE INDEX "MemoryExtractionProviderCall_chunkId_attemptCount_key"
    ON "MemoryExtractionProviderCall" ("chunkId", "attemptCount");

-- The reconciliation sweep looks for calls that were issued and never settled.
CREATE INDEX "MemoryExtractionProviderCall_callIssued_settledAt_idx"
    ON "MemoryExtractionProviderCall" ("callIssued", "settledAt");

ALTER TABLE "MemoryExtractionProviderCall"
    ADD CONSTRAINT "MemoryExtractionProviderCall_chunkId_fkey"
    FOREIGN KEY ("chunkId") REFERENCES "MemoryExtractionChunk"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
