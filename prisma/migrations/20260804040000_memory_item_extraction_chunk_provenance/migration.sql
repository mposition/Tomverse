-- Which extraction chunk produced a memory item (policy §11, §12).
--
-- Two jobs, and the second is why the columns are needed rather than nice to
-- have. As provenance they say which chunk of which run proposed a candidate.
-- As an idempotency key they let the persistence step replace one chunk's rows
-- on a retry: a chunk whose worker died after the provider answered but before
-- the transaction committed is re-claimed and re-run, and without a key
-- scoped to (run, chunk) the second attempt would add a second copy of every
-- candidate the first one already stored. The user would then review the same
-- statement twice, with two evidence rows pointing at the same message.
--
-- Nullable, and not a foreign key. Null covers user-authored items and every
-- row written before this migration. No relation because a run is operational
-- state that may be pruned, while an approved memory has to outlive the run
-- that proposed it -- a cascade here would delete a memory the user accepted.
ALTER TABLE "MemoryItem"
    ADD COLUMN "extractionRunId" TEXT,
    ADD COLUMN "extractionChunkIndex" INTEGER;

-- The persistence step's replace reads exactly this pair.
CREATE INDEX "MemoryItem_extractionRunId_extractionChunkIndex_idx"
    ON "MemoryItem" ("extractionRunId", "extractionChunkIndex");

-- Either both are set or neither is. A row that names a run but no chunk
-- cannot be replaced by the retry of any chunk, so it would survive as a
-- duplicate of whatever the retry writes -- exactly the failure the columns
-- exist to prevent.
ALTER TABLE "MemoryItem"
    ADD CONSTRAINT "MemoryItem_extraction_provenance_shape_check"
    CHECK (
        ("extractionRunId" IS NULL AND "extractionChunkIndex" IS NULL)
        OR ("extractionRunId" IS NOT NULL AND "extractionChunkIndex" IS NOT NULL)
    );
