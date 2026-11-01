-- The analysis behind a marketing brief (operator decision 2026-11-01): what
-- Tomverse is, where it stands against the tracked competitors, and what to
-- stress this week. The generator's analysis call writes it beside the brief
-- report it explains; a person reads it in the Reports tab. A5 is given the
-- brief, never this.
--
-- One row per brief report, inserted in the transaction that records the
-- brief (lib/marketingIntelReportStore.ts). `briefReportId` names the
-- MarketingReport row without a foreign key: a relation would add a back
-- relation to MarketingReport, a model the webhook pipeline fingerprint
-- watches. No user content and no personal data: our own pages, public
-- competitor facts and the model's reading of them.
--
-- What the database holds for any writer:
--   1. Timestamps are the database's: `createdAt` from its clock and
--      `retentionUntil` 24 months after it, as for the brief (policy §12.2).
--   2. A row never changes.
--   3. Deletion is retention's alone, past `retentionUntil`
--      (`marketing_retained_row_delete_is_bounded`, shared with MarketingReport).

-- CreateTable
CREATE TABLE "MarketingAnalysis" (
    "id" TEXT NOT NULL,
    "briefReportId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "retentionUntil" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAnalysis_briefReportId_key" ON "MarketingAnalysis"("briefReportId");

-- CreateIndex
CREATE INDEX "MarketingAnalysis_retentionUntil_idx" ON "MarketingAnalysis"("retentionUntil");

ALTER TABLE "MarketingAnalysis" ADD CONSTRAINT "MarketingAnalysis_payload_check"
    CHECK (pg_catalog.jsonb_typeof("payload") = 'object'
           AND pg_catalog.octet_length("payload"::text) <= 65536);
ALTER TABLE "MarketingAnalysis" ADD CONSTRAINT "MarketingAnalysis_retentionUntil_check"
    CHECK ("retentionUntil" = "createdAt" + INTERVAL '24 months');

CREATE FUNCTION "marketing_analysis_sets_its_retention"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    -- Both columns are overwritten, so a caller's values never reach the row.
    NEW."createdAt" := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';
    NEW."retentionUntil" := NEW."createdAt" + INTERVAL '24 months';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_analysis_sets_its_retention"
    BEFORE INSERT ON "MarketingAnalysis"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_analysis_sets_its_retention"();

CREATE FUNCTION "marketing_analysis_is_immutable"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'MarketingAnalysis % is immutable', OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_analysis_is_immutable"
    BEFORE UPDATE ON "MarketingAnalysis"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_analysis_is_immutable"();

CREATE TRIGGER "marketing_analysis_delete_is_bounded"
    BEFORE DELETE ON "MarketingAnalysis"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_retained_row_delete_is_bounded"();
