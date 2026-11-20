-- External API receipts record which wire protocol a request arrived on
-- (docs/policy/external-api.md, "Native protocols"). Additive only: one column
-- with a constant default, so existing rows read as Chat Completions -- the
-- only protocol that existed when they were written -- and PostgreSQL adds it
-- without rewriting the table. Content-free: a protocol name, never a body.
--
-- Rollback: ALTER TABLE "ExternalApiRequest" DROP COLUMN "protocol";
BEGIN;

ALTER TABLE "ExternalApiRequest" ADD COLUMN "protocol" TEXT NOT NULL DEFAULT 'chat_completions';

COMMIT;
