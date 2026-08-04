-- Extraction attempts, the confirmed quote, and candidate dedupe identity
-- (docs/policy/external-conversation-import-and-memory.md §11).
--
-- Forward-only and additive. Still nothing executes: this migration exists so
-- the slice that first calls a provider has somewhere honest to record what
-- it spent and what it produced.
--
-- The central correction this encodes: a chunk and an attempt are different
-- identities. The chunk (`runId:chunkIndex`) is the logical unit of work and
-- may be committed exactly once. An attempt (`runId:chunkIndex:attemptNumber`)
-- is one paid provider call, and there can be several. A single key cannot
-- serve both — one containing the attempt number is new on every retry and so
-- deduplicates nothing, while one without it would make a deliberate second
-- call indistinguishable from a replay.

-- The quote the user actually confirmed. Reservations are taken per chunk,
-- just before it runs, so this is what stops days-old pricing from quietly
-- charging more than was agreed.
ALTER TABLE "MemoryExtractionRun"
    ADD COLUMN "confirmedCreditCeiling" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "confirmedAt" TIMESTAMP(3),
    ADD COLUMN "quotePricingVersion" TEXT,
    ADD COLUMN "quoteExpiresAt" TIMESTAMP(3);

UPDATE "MemoryExtractionRun"
SET "confirmedAt" = COALESCE("confirmedAt", "createdAt"),
    "quotePricingVersion" = COALESCE("quotePricingVersion", "pricingVersion", ''),
    -- A run created before this migration keeps a zero ceiling, so the first
    -- just-in-time reservation exceeds it and the run stops for a re-quote.
    -- That is the safe outcome: we do not know what its owner agreed to.
    "quoteExpiresAt" = COALESCE("quoteExpiresAt", "createdAt");

ALTER TABLE "MemoryExtractionRun"
    ALTER COLUMN "confirmedAt" SET NOT NULL,
    ALTER COLUMN "quotePricingVersion" SET NOT NULL,
    ALTER COLUMN "quoteExpiresAt" SET NOT NULL;

ALTER TABLE "MemoryExtractionRun" ALTER COLUMN "confirmedCreditCeiling" DROP DEFAULT;

ALTER TABLE "MemoryExtractionChunk"
    ADD COLUMN "estimatedCredits" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: one deliberate provider call.
CREATE TABLE "MemoryExtractionAttempt" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "leaseGeneration" INTEGER NOT NULL,
    "reservationId" TEXT,
    "providerResponse" JSONB,
    "providerCallIssued" BOOLEAN NOT NULL DEFAULT false,
    "usageConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "failureCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryExtractionAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryExtractionAttempt_chunkId_attemptNumber_key"
    ON "MemoryExtractionAttempt"("chunkId", "attemptNumber");
CREATE UNIQUE INDEX "MemoryExtractionAttempt_reservationId_key"
    ON "MemoryExtractionAttempt"("reservationId");
CREATE INDEX "MemoryExtractionAttempt_status_idx"
    ON "MemoryExtractionAttempt"("status");

ALTER TABLE "MemoryExtractionAttempt"
    ADD CONSTRAINT "MemoryExtractionAttempt_chunkId_fkey"
    FOREIGN KEY ("chunkId") REFERENCES "MemoryExtractionChunk"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The full attempt lifecycle. `responded` is the state that makes crash
-- recovery honest: once a provider answer is durable, resuming commits it
-- rather than paying for the same answer a second time. `discarded_stale` is
-- an attempt whose worker lost its lease after spending money — settled, but
-- its candidates thrown away.
ALTER TABLE "MemoryExtractionAttempt"
    ADD CONSTRAINT "MemoryExtractionAttempt_status_check"
    CHECK ("status" IN (
        'planned', 'reserved', 'calling', 'responded', 'committed',
        'failed_before_call', 'failed_after_call', 'discarded_stale',
        'cancelled'
    ));

-- Candidate identity, so a retried chunk cannot store the same candidate
-- twice. NULL for user-authored memories; Postgres treats NULLs as distinct,
-- so they never collide with each other.
ALTER TABLE "MemoryItem" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "MemoryItem_userId_dedupeKey_key"
    ON "MemoryItem"("userId", "dedupeKey");
