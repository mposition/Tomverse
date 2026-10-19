-- Dynamic model catalogue for the image and coding categories (owner direction
-- 2026-10-19). New tables only; no existing row is touched. Chat models stay in
-- ModelRegistryEntry and are read through a view in lib/modelCatalog.ts.
--
-- NULL means "inherit the code profile" (lib/imageModelRegistry.ts); a value is
-- an operator override. Prices are append-only revisions so a price history
-- exists independently of AdminAuditLog.

CREATE TABLE "ModelCatalogEntry" (
    "category" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "enabled" BOOLEAN,
    "holdReason" TEXT,
    "sortOrder" INTEGER,
    "profile" JSONB,
    "draft" JSONB,
    "draftSource" TEXT,
    "draftCreatedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelCatalogEntry_pkey" PRIMARY KEY ("category", "modelId"),
    CONSTRAINT "ModelCatalogEntry_category_check" CHECK ("category" IN ('image', 'coding')),
    CONSTRAINT "ModelCatalogEntry_modelId_check" CHECK ("modelId" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$'),
    CONSTRAINT "ModelCatalogEntry_holdReason_check" CHECK ("holdReason" IS NULL OR length("holdReason") BETWEEN 1 AND 500),
    CONSTRAINT "ModelCatalogEntry_draftSource_check" CHECK ("draftSource" IS NULL OR "draftSource" IN ('llm'))
);

CREATE INDEX "ModelCatalogEntry_category_enabled_idx" ON "ModelCatalogEntry"("category", "enabled");

CREATE TABLE "ModelCatalogPriceRevision" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "pricingVersion" TEXT NOT NULL,
    "prices" JSONB NOT NULL,
    "verification" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelCatalogPriceRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ModelCatalogPriceRevision_category_check" CHECK ("category" IN ('image', 'coding')),
    -- No retroactive pricing: a revision takes effect at or after the moment it is written.
    CONSTRAINT "ModelCatalogPriceRevision_not_retroactive_check" CHECK ("effectiveFrom" >= "createdAt" - INTERVAL '1 minute')
);

CREATE UNIQUE INDEX "ModelCatalogPriceRevision_category_modelId_pricingVersion_key" ON "ModelCatalogPriceRevision"("category", "modelId", "pricingVersion");
CREATE INDEX "ModelCatalogPriceRevision_category_modelId_effectiveFrom_idx" ON "ModelCatalogPriceRevision"("category", "modelId", "effectiveFrom");

-- Append-only: refuse UPDATE and DELETE at the database.
CREATE FUNCTION "ModelCatalogPriceRevision_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ModelCatalogPriceRevision is append-only';
END;
$$;
CREATE TRIGGER "ModelCatalogPriceRevision_append_only_trigger"
    BEFORE UPDATE OR DELETE ON "ModelCatalogPriceRevision"
    FOR EACH ROW EXECUTE FUNCTION "ModelCatalogPriceRevision_append_only"();

CREATE TABLE "ModelCatalogSnapshot" (
    "version" SERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "coverageUntil" TIMESTAMP(3) NOT NULL,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelCatalogSnapshot_pkey" PRIMARY KEY ("version"),
    CONSTRAINT "ModelCatalogSnapshot_category_check" CHECK ("category" IN ('coding')),
    CONSTRAINT "ModelCatalogSnapshot_contentHash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "ModelCatalogSnapshot_category_contentHash_idx" ON "ModelCatalogSnapshot"("category", "contentHash");
CREATE INDEX "ModelCatalogSnapshot_category_version_idx" ON "ModelCatalogSnapshot"("category", "version");

-- Immutable once published.
CREATE FUNCTION "ModelCatalogSnapshot_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ModelCatalogSnapshot is immutable';
END;
$$;
CREATE TRIGGER "ModelCatalogSnapshot_immutable_trigger"
    BEFORE UPDATE OR DELETE ON "ModelCatalogSnapshot"
    FOR EACH ROW EXECUTE FUNCTION "ModelCatalogSnapshot_immutable"();
