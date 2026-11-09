-- Completion is an operator decision, separate from declining a suggestion.
-- Existing rows and the sent/AMUX-link constraint are preserved.
ALTER TABLE "ProductResearchSuggestion"
    DROP CONSTRAINT "ProductResearchSuggestion_status_check",
    ADD CONSTRAINT "ProductResearchSuggestion_status_check"
        CHECK ("status" IN ('open', 'dismissed', 'sent', 'completed'));
