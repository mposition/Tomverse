-- The images and videos marketing posts may carry, stored by the app
-- (operator decision 2026-10-31: the media CLI on the AMUX box makes them and
-- submits them; the app keeps the Guard, a person's approval and publishing).
--
-- A row is the hand-kept registry's entry (docs/marketing/asset-registry.json,
-- lib/marketingAssets.ts) plus where the file is: provenance, the channels it
-- may appear on with each one's disclosure decision, alt text per locale, and
-- the R2 object. A submitted row is trusted for nothing. Only a person's
-- approval -- an audit row checked here, about exactly these bytes -- puts it
-- in the registry the Guard and the publisher read.
--
-- The decision is checked against the audit row rather than by a foreign key
-- for the competitor registry's reason: a relation would add a back relation
-- to AdminAuditLog, and the audit chain is append-only.

CREATE SEQUENCE "MarketingAsset_registryVersion_seq" AS INTEGER;

-- CreateTable
CREATE TABLE "MarketingAsset" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "allowedChannels" TEXT[],
    "disclosure" JSONB NOT NULL,
    "alt" JSONB NOT NULL,
    "claimIds" TEXT[],
    "validUntil" DATE NOT NULL,
    "depictsProductInterface" BOOLEAN NOT NULL,
    "r2Key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "durationSeconds" INTEGER,
    "transcript" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "registryVersion" INTEGER,
    "decisionAuditLogId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAsset_r2Key_key" ON "MarketingAsset"("r2Key");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAsset_decisionAuditLogId_key" ON "MarketingAsset"("decisionAuditLogId");

-- CreateIndex
CREATE INDEX "MarketingAsset_status_idx" ON "MarketingAsset"("status");

-- ---------------------------------------------------------------------------
-- Shapes (lib/marketingAssets.ts marketingAssetSchema, lib/marketingAssetCore.ts)
-- ---------------------------------------------------------------------------

-- Every allowed channel has exactly one disclosure decision, every decision is
-- for an allowed channel, and an AI-origin asset has no `none` anywhere.
CREATE FUNCTION "marketing_asset_disclosure_valid"("channels" TEXT[], "disclosure" JSONB, "provenance" TEXT)
RETURNS boolean
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT pg_catalog.jsonb_typeof("disclosure") = 'object'
       AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys("disclosure"))
           = pg_catalog.cardinality("channels")
       AND (SELECT pg_catalog.bool_and(
                  "entry".key = ANY ("channels")
                  AND pg_catalog.jsonb_typeof("entry".value) = 'string'
                  AND ("entry".value #>> '{}') IN ('none', 'platform_label', 'caption_disclosure', 'platform_label_and_caption')
                  AND NOT ("provenance" IN ('ai_generated', 'ai_modified') AND ("entry".value #>> '{}') = 'none'))
              FROM pg_catalog.jsonb_each("disclosure") AS "entry")
$$ LANGUAGE sql;

-- Alt text: at least one locale, each a known one with 1 to 400 characters.
CREATE FUNCTION "marketing_asset_alt_valid"("alt" JSONB)
RETURNS boolean
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT pg_catalog.jsonb_typeof("alt") = 'object'
       AND COALESCE((SELECT pg_catalog.bool_and(
                  "entry".key IN ('en', 'ko', 'zh-Hant', 'zh-Hans')
                  AND pg_catalog.jsonb_typeof("entry".value) = 'string'
                  AND pg_catalog.length("entry".value #>> '{}') BETWEEN 1 AND 400)
              FROM pg_catalog.jsonb_each("alt") AS "entry"), false)
$$ LANGUAGE sql;

-- Everything the file says, per locale (the Guard read it before the row was
-- written): known locales, 1 to 20,000 characters each, and at least one for a
-- video, which always says something.
CREATE FUNCTION "marketing_asset_transcript_valid"("transcript" JSONB, "kind" TEXT)
RETURNS boolean
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT pg_catalog.jsonb_typeof("transcript") = 'object'
       AND ("kind" <> 'video' OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys("transcript")) > 0)
       AND COALESCE((SELECT pg_catalog.bool_and(
                  "entry".key IN ('en', 'ko', 'zh-Hant', 'zh-Hans')
                  AND pg_catalog.jsonb_typeof("entry".value) = 'string'
                  AND pg_catalog.length("entry".value #>> '{}') BETWEEN 1 AND 20000)
              FROM pg_catalog.jsonb_each("transcript") AS "entry"), true)
$$ LANGUAGE sql;

ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_id_check"
    CHECK ("id" ~ '^media-[a-z0-9][a-z0-9-]{0,99}$');
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_kind_check"
    CHECK ("kind" IN ('image', 'video'));
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_provenance_check"
    CHECK ("provenance" IN ('capture', 'operator_upload', 'ai_generated', 'ai_modified'));
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_status_check"
    CHECK ("status" IN ('submitted', 'approved', 'retired'));
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_allowedChannels_check"
    CHECK ("allowedChannels" IS NOT NULL
           AND pg_catalog.cardinality("allowedChannels") BETWEEN 1 AND 8
           AND "allowedChannels" <@ ARRAY['linkedin', 'x', 'facebook', 'instagram', 'threads', 'youtube', 'tiktok', 'rednote']::TEXT[]);
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_disclosure_check"
    CHECK ("marketing_asset_disclosure_valid"("allowedChannels", "disclosure", "provenance"));
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_alt_check"
    CHECK ("marketing_asset_alt_valid"("alt"));
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_transcript_check"
    CHECK ("marketing_asset_transcript_valid"("transcript", "kind"));
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_claimIds_check"
    CHECK ("claimIds" IS NOT NULL AND pg_catalog.cardinality("claimIds") <= 20);
-- A model-made picture of a screen is not a picture of the product (policy 7.3).
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_interface_check"
    CHECK (NOT ("provenance" IN ('ai_generated', 'ai_modified') AND "depictsProductInterface"));
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_file_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'
           AND "bytes" > 0
           AND (("kind" = 'image'
                 AND "contentType" IN ('image/png', 'image/jpeg', 'image/webp')
                 AND "bytes" <= 20971520
                 AND "durationSeconds" IS NULL)
             OR ("kind" = 'video'
                 AND "contentType" IN ('video/mp4', 'video/quicktime')
                 AND "bytes" <= 1073741824
                 AND "durationSeconds" BETWEEN 1 AND 3600)));
-- One object per asset, under the asset's own prefix.
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_r2Key_check"
    CHECK ("r2Key" = 'marketing-assets/' || "id" || '/original.' || CASE "contentType"
               WHEN 'image/png' THEN 'png' WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/webp' THEN 'webp'
               WHEN 'video/mp4' THEN 'mp4' WHEN 'video/quicktime' THEN 'mov' END);
-- A decided row names its decision and the registry version it made; a
-- submission has neither. Only an uploaded file can be approved.
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_decision_check"
    CHECK ((("status" = 'submitted') = ("decisionAuditLogId" IS NULL))
           AND (("decisionAuditLogId" IS NULL) = ("decidedAt" IS NULL))
           AND (("decisionAuditLogId" IS NULL) = ("registryVersion" IS NULL))
           AND ("status" <> 'approved' OR "uploadedAt" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- One guard for insert and update, reading the decision's audit row by a name
-- built from TG_TABLE_SCHEMA (search_path is pinned).
--
-- - An insert is a submission: nothing decided, nothing uploaded.
-- - The upload is recorded once, on a submission, and changes nothing else.
-- - A decision is a person's audit row (an actor, no system actor) for this
--   asset and this status, made with this row's previous decision in view
--   (':none' for none), and -- for an approval -- about exactly these bytes.
--   It takes the next registry version, so the registry the Guard reads moves
--   on every approval and retirement.
-- - What was submitted never changes: a different file is a different asset.
CREATE FUNCTION "marketing_asset_write_guard"() RETURNS trigger AS $$
DECLARE
    previous_decision TEXT;
    decision_action TEXT;
    decision_target_type TEXT;
    decision_target TEXT;
    decision_actor TEXT;
    decision_metadata JSONB;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'submitted' OR NEW."decisionAuditLogId" IS NOT NULL
           OR NEW."uploadedAt" IS NOT NULL OR NEW."registryVersion" IS NOT NULL THEN
            RAISE EXCEPTION 'marketing_asset_insert_not_submitted';
        END IF;
        NEW."decidedAt" := NULL;
        RETURN NEW;
    END IF;

    IF pg_catalog.jsonb_build_array(OLD."id", OLD."kind", OLD."provenance", OLD."allowedChannels",
                                    OLD."disclosure", OLD."alt", OLD."claimIds", OLD."validUntil",
                                    OLD."depictsProductInterface", OLD."r2Key", OLD."contentType",
                                    OLD."bytes", OLD."sha256", OLD."durationSeconds", OLD."transcript", OLD."createdAt")
       IS DISTINCT FROM
       pg_catalog.jsonb_build_array(NEW."id", NEW."kind", NEW."provenance", NEW."allowedChannels",
                                    NEW."disclosure", NEW."alt", NEW."claimIds", NEW."validUntil",
                                    NEW."depictsProductInterface", NEW."r2Key", NEW."contentType",
                                    NEW."bytes", NEW."sha256", NEW."durationSeconds", NEW."transcript", NEW."createdAt") THEN
        RAISE EXCEPTION 'marketing_asset_submission_is_immutable';
    END IF;

    -- The upload, recorded once on a submission.
    IF OLD."status" = 'submitted' AND NEW."status" = 'submitted' THEN
        IF OLD."uploadedAt" IS NOT NULL OR NEW."uploadedAt" IS NULL
           OR NEW."decisionAuditLogId" IS NOT NULL OR NEW."registryVersion" IS NOT NULL THEN
            RAISE EXCEPTION 'marketing_asset_upload_invalid';
        END IF;
        NEW."uploadedAt" := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
        NEW."decidedAt" := NULL;
        RETURN NEW;
    END IF;

    IF NEW."uploadedAt" IS DISTINCT FROM OLD."uploadedAt" THEN
        RAISE EXCEPTION 'marketing_asset_upload_invalid';
    END IF;
    IF NOT (
        (OLD."status" = 'submitted' AND NEW."status" IN ('approved', 'retired'))
        OR (OLD."status" = 'approved' AND NEW."status" = 'retired')
    ) THEN
        RAISE EXCEPTION 'marketing_asset_transition_invalid';
    END IF;
    IF NEW."status" = 'approved' AND OLD."uploadedAt" IS NULL THEN
        RAISE EXCEPTION 'marketing_asset_not_uploaded';
    END IF;
    IF NEW."decisionAuditLogId" IS NULL OR NEW."decisionAuditLogId" IS NOT DISTINCT FROM OLD."decisionAuditLogId" THEN
        RAISE EXCEPTION 'marketing_asset_decision_not_a_person';
    END IF;
    previous_decision := OLD."decisionAuditLogId";

    EXECUTE format(
        'SELECT "action", "targetType", "targetId", "actorUserId", "metadata"::jsonb FROM %I."AdminAuditLog" WHERE "id" = $1',
        TG_TABLE_SCHEMA)
        INTO decision_action, decision_target_type, decision_target, decision_actor, decision_metadata
        USING NEW."decisionAuditLogId";
    IF decision_action IS DISTINCT FROM ('marketing_asset.' || NEW."status")
       OR decision_target_type IS DISTINCT FROM 'MarketingAsset'
       OR decision_target IS DISTINCT FROM NEW."id"
       OR decision_actor IS NULL
       OR decision_metadata IS NULL
       OR pg_catalog.jsonb_typeof(decision_metadata) IS DISTINCT FROM 'object'
       OR (decision_metadata ->> 'systemActor') IS NOT NULL
       OR (decision_metadata ->> 'previousDecisionAuditLogId') IS DISTINCT FROM COALESCE(previous_decision, ':none')
       OR (NEW."status" = 'approved' AND (decision_metadata ->> 'sha256') IS DISTINCT FROM NEW."sha256") THEN
        RAISE EXCEPTION 'marketing_asset_decision_not_a_person';
    END IF;

    NEW."registryVersion" := pg_catalog.nextval(
        pg_catalog.format('%I.%I', TG_TABLE_SCHEMA, 'MarketingAsset_registryVersion_seq')::regclass)::INTEGER;
    NEW."decidedAt" := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE TRIGGER "MarketingAsset_write_guard"
    BEFORE INSERT OR UPDATE ON "MarketingAsset"
    FOR EACH ROW EXECUTE FUNCTION "marketing_asset_write_guard"();

-- An asset is retired, never deleted: the posts that carried it keep naming
-- the row that said what it was and who approved it.
CREATE FUNCTION "marketing_asset_is_never_deleted"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'marketing_asset_is_never_deleted';
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE TRIGGER "MarketingAsset_is_never_deleted"
    BEFORE DELETE ON "MarketingAsset"
    FOR EACH ROW EXECUTE FUNCTION "marketing_asset_is_never_deleted"();
