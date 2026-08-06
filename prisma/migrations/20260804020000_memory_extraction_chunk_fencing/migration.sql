-- Extraction run durability: lease fencing and per-chunk state
-- (docs/policy/external-conversation-import-and-memory.md §11).
--
-- Forward-only and additive. Nothing here enables execution: the two drivers
-- (a post-response kick and the fifteen-minute recovery dispatcher) are wired
-- in a later slice, and this migration is what makes it safe for both to
-- exist at once.
--
-- Why a fencing token and not just a lease deadline: the previous claim
-- accepted any run in `pending` OR `running` and stored no owner, so two
-- claimants could both succeed and both drive the same run — duplicate
-- provider calls and duplicate candidates. `leaseGeneration` increments on
-- every claim and every subsequent write is conditioned on it, so exactly one
-- worker can act at a time and a superseded one fails closed.

ALTER TABLE "MemoryExtractionRun"
    ADD COLUMN "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "leaseOwner" TEXT;

-- CreateTable: durable per-call state (progress, retry budget, failure).
CREATE TABLE "MemoryExtractionChunk" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "conversationIds" JSONB NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseGeneration" INTEGER,
    "failureCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- No DB default, matching @updatedAt elsewhere: Prisma writes it on every
    -- update, and a database default here would read as drift.
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryExtractionChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryExtractionChunk_runId_chunkIndex_key"
    ON "MemoryExtractionChunk"("runId", "chunkIndex");
CREATE INDEX "MemoryExtractionChunk_runId_status_idx"
    ON "MemoryExtractionChunk"("runId", "status");

ALTER TABLE "MemoryExtractionChunk"
    ADD CONSTRAINT "MemoryExtractionChunk_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "MemoryExtractionRun"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryExtractionChunk"
    ADD CONSTRAINT "MemoryExtractionChunk_status_check"
    CHECK ("status" IN ('pending', 'running', 'completed', 'failed'));

-- Backfill so there is exactly one read path afterwards: every existing run
-- gets its chunk rows, with the ones the counter already counted marked
-- completed.
--
-- Two things are deliberately left empty for backfilled rows, because the
-- old schema never recorded them and inventing them would be worse than a
-- gap: `completedAt` stays NULL (we do not know when), and `conversationIds`
-- is an empty array (the per-chunk plan was never stored, and re-deriving it
-- from a differently-ordered query could hand a worker a chunk the user was
-- not quoted for). A run created before this migration therefore cannot be
-- resumed by the new processor — it can only be cancelled and re-created.
-- This costs nothing today: extraction has never executed in any environment,
-- because no executor exists and the rollout flag is off.
INSERT INTO "MemoryExtractionChunk" (
    "id", "runId", "chunkIndex", "status", "conversationIds",
    "attemptCount", "createdAt", "updatedAt"
)
SELECT
    'mecbf_' || r."id" || '_' || g."i",
    r."id",
    g."i",
    CASE WHEN g."i" < r."chunkCompleted" THEN 'completed' ELSE 'pending' END,
    '[]'::jsonb,
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "MemoryExtractionRun" r
CROSS JOIN LATERAL generate_series(0, r."chunkTotal" - 1) AS g("i")
WHERE r."chunkTotal" > 0;
