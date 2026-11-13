-- Additive: image billing terms an operator confirms from a measurement in the
-- admin console, and the measurements themselves (image policy section 12.1).
CREATE TABLE "ImageModelBillingTerms" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiModelId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "terms" JSONB NOT NULL,
    "sources" JSONB NOT NULL,
    "measurementId" TEXT,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageModelBillingTerms_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImageBillingMeasurement" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiModelId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "maxCostMicroUsd" INTEGER NOT NULL,
    "spentMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "samples" JSONB NOT NULL,
    "verdict" JSONB,
    "stopReason" TEXT,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ImageBillingMeasurement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImageModelBillingTerms_provider_apiModelId_createdAt_idx" ON "ImageModelBillingTerms"("provider", "apiModelId", "createdAt");

-- Append-only: the judge, the request and settlement read these terms, so a
-- change is a new row with its own audit entry, never an edit. UPDATE and
-- DELETE are refused per row, TRUNCATE per statement.
CREATE FUNCTION "ImageModelBillingTerms_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ImageModelBillingTerms is append-only';
END;
$$;
CREATE TRIGGER "ImageModelBillingTerms_append_only_trigger"
    BEFORE UPDATE OR DELETE ON "ImageModelBillingTerms"
    FOR EACH ROW EXECUTE FUNCTION "ImageModelBillingTerms_append_only"();
CREATE TRIGGER "ImageModelBillingTerms_no_truncate_trigger"
    BEFORE TRUNCATE ON "ImageModelBillingTerms"
    FOR EACH STATEMENT EXECUTE FUNCTION "ImageModelBillingTerms_append_only"();
CREATE INDEX "ImageBillingMeasurement_provider_apiModelId_createdAt_idx" ON "ImageBillingMeasurement"("provider", "apiModelId", "createdAt");
CREATE INDEX "ImageBillingMeasurement_status_idx" ON "ImageBillingMeasurement"("status");
