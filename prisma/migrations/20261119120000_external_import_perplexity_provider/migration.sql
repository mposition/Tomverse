-- Admit Perplexity as an external import provider.
--
-- Perplexity has no account-wide export; each thread exports itself as one
-- Markdown file, which lib/externalImportAdapters/perplexity.ts reads in the
-- browser like every other provider's export. Without this migration the
-- browser parses the file and the row cannot be written -- the failure the
-- Gemini migration (20260815100000) was written to prevent.
--
-- The allowed set has one authority in the application
-- (lib/externalImportProviders.ts). SQL cannot import it, so the three
-- copies below are held to that list by npm run check:enum-constraints and
-- tests/integration/external-import-provider-canon.db.test.ts.
--
-- Widening a CHECK is backward compatible: every existing row satisfies the
-- new constraint, and code that never writes 'perplexity' is unaffected.
-- Migrate the database first, deploy the application after.

ALTER TABLE "ExternalImport"
    DROP CONSTRAINT IF EXISTS "ExternalImport_provider_check";
ALTER TABLE "ExternalImport"
    ADD CONSTRAINT "ExternalImport_provider_check"
    CHECK ("provider" IN ('chatgpt', 'claude', 'gemini', 'perplexity'));

ALTER TABLE "ExternalConversation"
    DROP CONSTRAINT IF EXISTS "ExternalConversation_provider_check";
ALTER TABLE "ExternalConversation"
    ADD CONSTRAINT "ExternalConversation_provider_check"
    CHECK ("provider" IN ('chatgpt', 'claude', 'gemini', 'perplexity'));

ALTER TABLE "ConversationContinuationBridge"
    DROP CONSTRAINT IF EXISTS "ConversationContinuationBridge_provider_check";
ALTER TABLE "ConversationContinuationBridge"
    ADD CONSTRAINT "ConversationContinuationBridge_provider_check"
    CHECK ("provider" IN ('chatgpt', 'claude', 'gemini', 'perplexity'));
