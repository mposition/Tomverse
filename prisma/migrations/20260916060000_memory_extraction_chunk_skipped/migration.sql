-- A chunk that finished without calling the provider.
--
-- The settlement contract says in two places that a completed chunk really did
-- call the provider (lib/memoryExtractionCredits.ts, and again at the call
-- site in lib/memoryExtractionService.ts), and `chunksCharged` is the count of
-- completed chunks. But a chunk whose conversations have all gone -- deleted,
-- or their import removed -- returns `completed` so the run can finish, and is
-- therefore charged for a call nobody made.
--
-- `skipped` is that outcome with its own name: terminal like `completed`, not
-- retried, counted as processed for run termination and progress, and excluded
-- from `chunksCharged`.
--
-- The column keeps its CHECK rather than becoming an enum, for the reason
-- scripts/check-enum-constraints.mjs records: the chunk lifecycle is not the
-- run lifecycle, and sharing a type would widen this column.
--
-- Two separate questions, and the answer to one is not the answer to the other.
--
-- Will existing rows pass? Yes, by construction: every value the old CHECK
-- allowed, the new one allows, so there is nothing to backfill and no row that
-- could fail validation.
--
-- What does validating cost? `ADD CONSTRAINT` without NOT VALID still scans the
-- table under a lock, and the first answer says nothing about that. It is
-- acceptable here for a reason of its own: the table holds almost nothing,
-- because extraction has never run in production (below). A table with real
-- volume would want NOT VALID followed by a separate VALIDATE, even for a
-- widening like this one.
--
-- Nothing is owed for the old behaviour: `feature.memoryExtractionEnabled` has
-- never been switched on in production (confirmed by the operator,
-- 2026-09-16), so no account was ever charged for a chunk that called nobody.
-- This is the fix arriving before the flag rather than after it.
ALTER TABLE "MemoryExtractionChunk"
    DROP CONSTRAINT "MemoryExtractionChunk_status_check";

ALTER TABLE "MemoryExtractionChunk"
    ADD CONSTRAINT "MemoryExtractionChunk_status_check"
    CHECK ("status" IN ('pending', 'running', 'completed', 'skipped', 'failed'));
