-- Retrieval v1 (policy §9): make `retrievalVersion` mean "which tokenizer
-- produced the terms on this row", so the backfill can find rows that have
-- none.
--
-- The column shipped with the memory schema defaulting to 1, but nothing ever
-- wrote `searchTerms`: every existing row therefore claims to be indexed by v1
-- while holding an empty term array, and a `retrievalVersion < 1` backfill
-- would match nothing and silently leave the whole store unsearchable.
--
-- 0 now means "no terms computed yet". Existing rows are reset to it because
-- that is what they actually are, and every write path from here on sets the
-- current version alongside the terms it just computed.

ALTER TABLE "MemoryItem" ALTER COLUMN "retrievalVersion" SET DEFAULT 0;

UPDATE "MemoryItem"
SET "retrievalVersion" = 0
WHERE "searchTerms" = ARRAY[]::text[];
