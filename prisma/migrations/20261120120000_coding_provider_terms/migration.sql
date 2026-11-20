-- Provider conditions for the coding catalogue (owner decision 2026-11-20).
-- One row per provider: whether its terms allow resale and coding-agent use,
-- its data retention page and its processing region, read by every coding
-- model of that provider (lib/modelCatalogCore.ts resolveCodingEntry). New
-- table only; no existing row is touched. A coding row that names its own
-- terms keeps them until its provider has a row here.
--
-- `terms` is what an operator applied; `draft` is an LLM re-check waiting for
-- one. A record checked more than 90 days ago must be checked again before a
-- new model of that provider is turned on.

CREATE TABLE "CodingProviderTerms" (
    "provider" TEXT NOT NULL,
    "terms" JSONB,
    "draft" JSONB,
    "draftSource" TEXT,
    "draftCreatedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodingProviderTerms_pkey" PRIMARY KEY ("provider"),
    CONSTRAINT "CodingProviderTerms_provider_check" CHECK ("provider" ~ '^[a-z][a-z0-9-]{0,39}$'),
    CONSTRAINT "CodingProviderTerms_draftSource_check" CHECK ("draftSource" IS NULL OR "draftSource" IN ('llm'))
);
