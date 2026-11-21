-- External API receipts record which of the two external APIs a request came
-- through (owner decision 2026-11-21, docs/policy/external-api.md): general
-- (/api/v1, /api/anthropic) or coding (/api/code/v1, /api/code/anthropic).
-- Additive only: one nullable column, so PostgreSQL adds it without rewriting
-- the table, and rows written before it stay NULL -- not recorded, never
-- guessed (no backfill). The CHECK names the two values the application writes
-- (lib/externalApiCatalogCore.ts EXTERNAL_API_SURFACES). Content-free: an API
-- name, never a body.
--
-- Rollback: ALTER TABLE "ExternalApiRequest" DROP COLUMN "surface";
ALTER TABLE "ExternalApiRequest"
    ADD COLUMN "surface" TEXT,
    ADD CONSTRAINT "ExternalApiRequest_surface_check" CHECK ("surface" IN ('general', 'coding'));
