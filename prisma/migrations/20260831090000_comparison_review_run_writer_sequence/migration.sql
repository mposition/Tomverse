-- Makes a missing telemetry write countable.
--
-- The scorecard reads rows that landed, so a partial outage -- inserts failing
-- for some runs and not others -- left every rate looking healthy while the
-- runs behind the failures were simply absent. The structured
-- `comparison_review_run_record_failed` event records each failure, but
-- nothing in the database could state a rate.
--
-- A writer id plus a sequence that increments on every ATTEMPTED write gives
-- the rows an expected count: within one writer, the highest sequence minus
-- the lowest, plus one, is how many writes were tried, and the number of rows
-- present is how many landed. The difference is the gap.
--
-- Defaults are additive so existing rows stay readable; rows written before
-- this migration carry writerId '' and are excluded from the measurement
-- rather than counted as a single enormous writer.
ALTER TABLE "ComparisonReviewRun"
    ADD COLUMN "writerId" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "writerSequence" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "ComparisonReviewRun_writerId_writerSequence_idx"
    ON "ComparisonReviewRun" ("writerId", "writerSequence");
