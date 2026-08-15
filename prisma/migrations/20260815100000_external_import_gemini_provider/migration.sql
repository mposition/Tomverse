-- A2: admit Gemini as an external import provider.
--
-- docs/policy/external-import-gemini-a2.md. The Release A migration wrote
-- these two constraints and said what would be needed next:
--
--   "Release A supports exactly these providers; Gemini arrives as its own
--    release (A2) with its own parser, fixtures and migration (§1)."
--
-- The parser and the fixtures landed; this is the migration. Without it the
-- browser parses a Takeout export and the row cannot be written, which is a
-- failure the user meets after choosing their conversations.
--
-- The allowed set has one authority in the application
-- (lib/externalImportProviders.ts) and SQL cannot import it, so the copy
-- below is held to that list by
-- tests/integration/external-import-provider-canon.db.test.ts.
--
-- Widening a CHECK is backward compatible: every row that satisfied the old
-- constraint satisfies this one, and code that only ever writes 'chatgpt' or
-- 'claude' is unaffected. That is why the database is migrated first and the
-- application deployed after -- the reverse order lets a Gemini import fail
-- at the constraint.

ALTER TABLE "ExternalImport"
    DROP CONSTRAINT IF EXISTS "ExternalImport_provider_check";
ALTER TABLE "ExternalImport"
    ADD CONSTRAINT "ExternalImport_provider_check"
    CHECK ("provider" IN ('chatgpt', 'claude', 'gemini'));

ALTER TABLE "ExternalConversation"
    DROP CONSTRAINT IF EXISTS "ExternalConversation_provider_check";
ALTER TABLE "ExternalConversation"
    ADD CONSTRAINT "ExternalConversation_provider_check"
    CHECK ("provider" IN ('chatgpt', 'claude', 'gemini'));
