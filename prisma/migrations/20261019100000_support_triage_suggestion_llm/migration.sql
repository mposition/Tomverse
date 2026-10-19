-- Support-triage suggestion: the LLM step's answer (owner direction 2026-10-19).
--
-- Three nullable or defaulted columns on an existing table; no row is
-- rewritten. A ready row records where its lane came from, the open reports
-- the model named as duplicates (at most five ids), and a reply draft shown to
-- the operator (at most 2,000 characters). Nothing here sends anything.

ALTER TABLE "SupportTriageSuggestion"
    ADD COLUMN "laneSource" TEXT,
    ADD COLUMN "duplicateOfFeedbackIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "replyDraft" TEXT;

ALTER TABLE "SupportTriageSuggestion"
    ADD CONSTRAINT "SupportTriageSuggestion_laneSource_check"
        CHECK ("laneSource" IS NULL OR "laneSource" IN ('keyword', 'llm')),
    -- limit: DUPLICATES_MAX
    ADD CONSTRAINT "SupportTriageSuggestion_duplicateOfFeedbackIds_check"
        CHECK (pg_catalog.cardinality("duplicateOfFeedbackIds") <= 5),
    -- limit: REPLY_DRAFT_MAX_CHARS
    ADD CONSTRAINT "SupportTriageSuggestion_replyDraft_check"
        CHECK ("replyDraft" IS NULL OR pg_catalog.char_length("replyDraft") <= 2000);
