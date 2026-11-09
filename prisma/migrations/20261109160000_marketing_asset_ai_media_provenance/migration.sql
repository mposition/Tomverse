-- baseline-check: present-if-function "marketing_asset_disclosure_valid_v3"
--
-- A video whose product screens are real captures, unchanged, cut with
-- model-made shots that show no product screen, a model-made voice and music
-- (owner decision 2026-11-09): `capture_with_ai_media`. Like
-- `capture_with_ai_presenter` it is of AI origin, so every channel it may
-- appear on needs a disclosure other than `none` and YouTube is told it
-- contains synthetic media; it may depict the product interface, because no
-- screen in it is model-made; and it is a video's provenance only
-- (lib/marketingAssets.ts, lib/marketingAssetSubmission.ts).
--
-- MarketingAsset_interface_check is unchanged: it names `ai_generated` and
-- `ai_modified`, which still may not show the product. No existing row has the
-- new value, so every re-added check holds for the rows already there.
--
-- The disclosure rule moves to a new function, as in
-- 20261107130000_marketing_asset_ai_presenter_provenance, so the pre-deploy
-- baseline guard can probe for it; the v2 function is dropped once the check
-- no longer uses it.

CREATE FUNCTION "marketing_asset_disclosure_valid_v3"("channels" TEXT[], "disclosure" JSONB, "provenance" TEXT)
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
                  AND NOT ("provenance" IN ('ai_generated', 'ai_modified', 'capture_with_ai_presenter', 'capture_with_ai_media')
                           AND ("entry".value #>> '{}') = 'none'))
              FROM pg_catalog.jsonb_each("disclosure") AS "entry")
$$ LANGUAGE sql;


ALTER TABLE "MarketingAsset"
    DROP CONSTRAINT "MarketingAsset_provenance_check",
    ADD CONSTRAINT "MarketingAsset_provenance_check"
    CHECK ("provenance" IN ('capture', 'operator_upload', 'ai_generated', 'ai_modified', 'capture_with_ai_presenter', 'capture_with_ai_media'));

ALTER TABLE "MarketingAsset"
    DROP CONSTRAINT "MarketingAsset_disclosure_check",
    ADD CONSTRAINT "MarketingAsset_disclosure_check"
    CHECK ("marketing_asset_disclosure_valid_v3"("allowedChannels", "disclosure", "provenance"));

-- Shots, a voice and music cut with captures: the provenance is a video's.
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_ai_media_check"
    CHECK ("provenance" <> 'capture_with_ai_media' OR "kind" = 'video');

DROP FUNCTION "marketing_asset_disclosure_valid_v2"(TEXT[], JSONB, TEXT);
