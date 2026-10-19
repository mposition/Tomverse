-- Product-research scout suggestions (owner direction 2026-10-19, LLM-first).
--
-- One new table, no existing row touched. The model's answer is parsed against
-- the lists in lib/productResearchScoutCore.ts before the insert; the CHECKs
-- hold the same lists and bounds so a writer that skipped the parse is
-- refused here. No column links a user.

CREATE TABLE "ProductResearchSuggestion" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "statusChangedAt" TIMESTAMP(3),
    "amuxIdeaId" TEXT,
    "modelId" TEXT,

    CONSTRAINT "ProductResearchSuggestion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductResearchSuggestion_kind_check"
        CHECK ("kind" IN ('page', 'file', 'catalogue')),
    CONSTRAINT "ProductResearchSuggestion_area_check"
        CHECK ("area" IN ('ui', 'copy', 'accessibility', 'mobile', 'performance', 'generated_file', 'catalogue', 'other')),
    CONSTRAINT "ProductResearchSuggestion_severity_check"
        CHECK ("severity" IN ('low', 'medium', 'high')),
    CONSTRAINT "ProductResearchSuggestion_status_check"
        CHECK ("status" IN ('open', 'dismissed', 'sent')),
    -- limits: SUGGESTION_TITLE_MAX_CHARS, SUGGESTION_TEXT_MAX_CHARS
    CONSTRAINT "ProductResearchSuggestion_text_check"
        CHECK (pg_catalog.char_length("subject") BETWEEN 1 AND 64
               AND pg_catalog.char_length("title") BETWEEN 1 AND 160
               AND pg_catalog.char_length("evidence") BETWEEN 1 AND 1000
               AND pg_catalog.char_length("suggestion") BETWEEN 1 AND 1000),
    CONSTRAINT "ProductResearchSuggestion_sent_check"
        CHECK (("status" = 'sent') = ("amuxIdeaId" IS NOT NULL))
);

CREATE INDEX "ProductResearchSuggestion_status_createdAt_idx"
    ON "ProductResearchSuggestion"("status", "createdAt");
CREATE INDEX "ProductResearchSuggestion_subject_createdAt_idx"
    ON "ProductResearchSuggestion"("subject", "createdAt");
