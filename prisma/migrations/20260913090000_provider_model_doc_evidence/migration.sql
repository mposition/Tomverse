-- What a provider's own documentation said about one model, read after the
-- daily catalogue scan.
--
-- Purely additive: a new table, no existing column touched. Reversing it is
-- DROP TABLE, and nothing reads it but the adoption draft and the daily
-- report, both of which treat a missing row as "no evidence".
--
-- Why a table and not `ProviderModelCatalogEntry.metadata`: the scan rewrites
-- that JSON wholesale on every run, and evidence has a lifecycle of its own --
-- it is read from different hosts, can fail while the scan succeeds, and has
-- to carry where it came from (URL, digest of the document, parser version)
-- for an operator to check the number before trusting it. Folding it into the
-- scan's metadata would have the next scan erase it.
--
-- Not a price source. `lib/modelPricing.ts` is (docs/policy/credit-and-cost-limits.md
-- §3). Nothing in the request path reads this table.
CREATE TABLE "ProviderModelDocEvidence" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiModel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sources" JSONB NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "fields" JSONB,
    "problems" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderModelDocEvidence_pkey" PRIMARY KEY ("id")
);

-- One row per exact pair the catalogue observed, overwritten by each read: the
-- current evidence is the only evidence an adoption can use, and history of a
-- price lives in `lib/modelPricing.ts`'s schedule, not here.
CREATE UNIQUE INDEX "ProviderModelDocEvidence_provider_apiModel_key"
    ON "ProviderModelDocEvidence"("provider", "apiModel");
CREATE INDEX "ProviderModelDocEvidence_status_fetchedAt_idx"
    ON "ProviderModelDocEvidence"("status", "fetchedAt");

-- lib/providerModelDocsCore.ts PROVIDER_MODEL_DOC_EVIDENCE_STATUSES.
ALTER TABLE "ProviderModelDocEvidence" ADD CONSTRAINT "ProviderModelDocEvidence_status_check"
    CHECK ("status" IN ('parsed', 'not_found', 'fetch_failed', 'parse_failed'));
