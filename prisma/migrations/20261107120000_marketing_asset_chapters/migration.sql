-- A long video's YouTube chapters (owner decision 2026-11-07): where each
-- section starts and its title per locale. The media CLI that cut the video
-- sends them with the submission; the draft intake writes them into a YouTube
-- description before the Guard and the envelope digest see the text, so the
-- times never come from a model (lib/marketingVideoChapters.ts).
--
-- The rules repeat lib/marketingVideoChapters.ts and YouTube's own
-- (https://support.google.com/youtube/answer/9884579): a video only; 3 to 20
-- chapters; the first at 0 seconds; each start a whole second, at least 10
-- seconds after the one before; the last at least 10 seconds before the end;
-- every chapter titled in each locale the asset has alt text for, 1 to 60
-- characters on one line with nothing to trim and no `#` (the list is added
-- after the hashtags were bounded), in known locales only. Whitespace here is
-- the database's [[:space:]]; the application's trim also takes the rest of
-- Unicode's, and refuses first.
--
-- Like the rest of a submission, chapters never change once the row exists:
-- a person approves exactly what was submitted. The existing write guard's
-- list of immutable columns predates this column, so a second trigger holds it.
-- Existing rows get NULL: no chapters.

-- AlterTable
ALTER TABLE "MarketingAsset" ADD COLUMN "chapters" JSONB;

CREATE FUNCTION "marketing_asset_chapters_valid"("chapters" JSONB, "durationSeconds" INTEGER, "alt" JSONB)
RETURNS boolean
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    -- CASE rather than AND wherever a step would raise on the wrong shape:
    -- PostgreSQL does not promise to evaluate AND operands in order.
    SELECT CASE
        WHEN pg_catalog.jsonb_typeof("chapters") <> 'array' OR pg_catalog.jsonb_typeof("alt") <> 'object' THEN false
        WHEN pg_catalog.jsonb_array_length("chapters") NOT BETWEEN 3 AND 20 THEN false
        ELSE COALESCE((
            SELECT pg_catalog.bool_and(
                       "chapter"."start" IS NOT NULL
                   AND "chapter"."titled"
                   AND CASE WHEN "chapter"."position" = 1 THEN "chapter"."start" = 0
                            ELSE "chapter"."start" - "chapter"."previous" >= 10 END
                   AND "durationSeconds" - "chapter"."start" >= 10)
              FROM (
                SELECT "entry"."position",
                       "entry"."start",
                       pg_catalog.lag("entry"."start") OVER (ORDER BY "entry"."position") AS "previous",
                       "entry"."titled"
                  FROM (
                    SELECT "element"."position",
                           CASE
                               WHEN pg_catalog.jsonb_typeof("element"."value") <> 'object' THEN NULL
                               WHEN NOT ("element"."value" ?& ARRAY['startSeconds', 'title']) THEN NULL
                               WHEN (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys("element"."value")) <> 2 THEN NULL
                               WHEN pg_catalog.jsonb_typeof("element"."value" -> 'startSeconds') <> 'number' THEN NULL
                               WHEN ("element"."value" ->> 'startSeconds') !~ '^(0|[1-9][0-9]{0,3})$' THEN NULL
                               ELSE ("element"."value" ->> 'startSeconds')::INTEGER
                           END AS "start",
                           CASE
                               WHEN pg_catalog.jsonb_typeof("element"."value") <> 'object' THEN false
                               WHEN pg_catalog.jsonb_typeof("element"."value" -> 'title') IS DISTINCT FROM 'object' THEN false
                               WHEN NOT (("element"."value" -> 'title') ?& ARRAY(SELECT pg_catalog.jsonb_object_keys("alt"))) THEN false
                               ELSE COALESCE((
                                   SELECT pg_catalog.bool_and(
                                              "title".key IN ('en', 'ko', 'zh-Hant', 'zh-Hans')
                                          AND pg_catalog.jsonb_typeof("title".value) = 'string'
                                          AND pg_catalog.length("title".value #>> '{}') BETWEEN 1 AND 60
                                          -- One line: no control character and no line or
                                          -- paragraph separator (U+2028, U+2029); no `#`.
                                          AND ("title".value #>> '{}')
                                              !~ ('[[:cntrl:]#' || pg_catalog.chr(8232) || pg_catalog.chr(8233) || ']')
                                          -- Nothing to trim, so a blank title is no title.
                                          AND ("title".value #>> '{}') !~ '^[[:space:]]|[[:space:]]$')
                                     FROM pg_catalog.jsonb_each("element"."value" -> 'title') AS "title"), false)
                           END AS "titled"
                      FROM pg_catalog.jsonb_array_elements("chapters") WITH ORDINALITY AS "element"("value", "position")
                  ) AS "entry"
              ) AS "chapter"), false)
    END
$$ LANGUAGE sql;

-- NULL is no chapters. A STRICT function answers NULL for an image (no
-- duration), and a CHECK passes on NULL, so the kind is named and the answer
-- must be true.
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_chapters_check"
    CHECK ("chapters" IS NULL
           OR ("kind" = 'video' AND "marketing_asset_chapters_valid"("chapters", "durationSeconds", "alt") IS TRUE));

-- Chapters are part of the submission, so they are as immutable as the rest of
-- it, with the same refusal the write guard raises.
CREATE FUNCTION "marketing_asset_chapters_are_immutable"() RETURNS trigger AS $$
BEGIN
    IF NEW."chapters" IS DISTINCT FROM OLD."chapters" THEN
        RAISE EXCEPTION 'marketing_asset_submission_is_immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE TRIGGER "MarketingAsset_chapters_are_immutable"
    BEFORE UPDATE ON "MarketingAsset"
    FOR EACH ROW EXECUTE FUNCTION "marketing_asset_chapters_are_immutable"();
