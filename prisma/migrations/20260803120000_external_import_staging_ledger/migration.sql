-- External import staging ledger (A1b).
--
-- docs/policy/external-conversation-import-and-memory.md §5.5.
--
-- Batches are accepted strictly in sequence. A network retry resends the
-- *last* batch, so recording one (sequence, payload digest) pair per import
-- distinguishes the two failure modes the error contract separates:
--
--   * same sequence + same digest   -> idempotent 200 (the retry case)
--   * same sequence + other digest  -> 409 EXTERNAL_IMPORT_BATCH_CONFLICT
--   * any other sequence            -> 409 EXTERNAL_IMPORT_BATCH_OUT_OF_ORDER
--
-- finalizeIdempotencyKey backs the finalize contract the same way: same key +
-- same import digest replays the stored success, a different key against a
-- completed import is EXTERNAL_IMPORT_ALREADY_FINALIZED.
ALTER TABLE "ExternalImport"
    ADD COLUMN "lastBatchSequence" INTEGER NOT NULL DEFAULT -1,
    ADD COLUMN "lastBatchDigest" TEXT,
    ADD COLUMN "finalizeIdempotencyKey" TEXT;
