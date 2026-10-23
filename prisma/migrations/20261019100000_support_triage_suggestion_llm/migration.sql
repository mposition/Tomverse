-- Support-triage suggestion: the LLM step's answer (owner direction 2026-10-19).
--
-- Four defaulted or nullable columns on an existing table; no row is
-- rewritten. A ready row records where its lane came from, every other report
-- the model was shown (at most 30 ids, so an account deletion of any of them
-- finds and deletes this row), the ones it named as duplicates (at most five,
-- always among those shown), and a reply draft shown to the operator (at most
-- 2,000 characters). Nothing here sends anything.

ALTER TABLE "SupportTriageSuggestion"
    ADD COLUMN "laneSource" TEXT,
    ADD COLUMN "contextFeedbackIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "duplicateOfFeedbackIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "replyDraft" TEXT;

ALTER TABLE "SupportTriageSuggestion"
    ADD CONSTRAINT "SupportTriageSuggestion_laneSource_check"
        CHECK ("laneSource" IS NULL OR "laneSource" IN ('keyword', 'llm')),
    -- limit: DUPLICATE_CANDIDATES_MAX
    ADD CONSTRAINT "SupportTriageSuggestion_contextFeedbackIds_check"
        CHECK (pg_catalog.cardinality("contextFeedbackIds") <= 30),
    -- limit: DUPLICATES_MAX
    ADD CONSTRAINT "SupportTriageSuggestion_duplicateOfFeedbackIds_check"
        CHECK (pg_catalog.cardinality("duplicateOfFeedbackIds") <= 5
               AND "duplicateOfFeedbackIds" <@ "contextFeedbackIds"),
    -- limit: REPLY_DRAFT_MAX_CHARS
    ADD CONSTRAINT "SupportTriageSuggestion_replyDraft_check"
        CHECK ("replyDraft" IS NULL OR pg_catalog.char_length("replyDraft") <= 2000);

-- An account deletion finds suggestions that saw one of its reports.
CREATE INDEX "SupportTriageSuggestion_contextFeedbackIds_idx"
    ON "SupportTriageSuggestion" USING GIN ("contextFeedbackIds");
