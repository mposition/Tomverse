-- Support-triage: one open suggestion per (report, input), not one row ever.
--
-- schema.prisma cannot express the partial index, but this migration also
-- drops a unique index and creates a plain one that `migrate diff` does see,
-- so the deploy guard needs no presence declaration here.
--
-- The unique (feedbackId, inputDigest) covered terminal rows too. When a
-- report's input returned to an earlier value (A, then B, then A again), A's
-- row was already superseded and no new A row could be made, so B's proposal
-- stayed ready for an input that no longer existed. The key now covers open
-- rows only (pending, claimed, ready): there is still at most one open
-- suggestion per report and input, and a terminal row no longer blocks a new
-- one. This migration writes no row.

BEGIN;

DROP INDEX "SupportTriageSuggestion_feedbackId_inputDigest_key";

CREATE UNIQUE INDEX "SupportTriageSuggestion_open_input_key"
    ON "SupportTriageSuggestion" ("feedbackId", "inputDigest")
    WHERE "state" IN ('pending', 'claimed', 'ready');

-- The lookup the dropped index served, without the uniqueness.
CREATE INDEX "SupportTriageSuggestion_feedbackId_inputDigest_idx"
    ON "SupportTriageSuggestion" ("feedbackId", "inputDigest");

COMMIT;
