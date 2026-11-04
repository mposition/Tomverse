-- A plaintext title for each AMUX idea (owner decision 2026-11-04). The body is
-- encrypted and a lane idea registers no card, so the Ideas tab could only show
-- a request id. New ideas take the body's first non-blank line, at most 80
-- characters (lib/amux/ideaTitleCore.ts); no model call makes it.
--
-- The title is part of the body, so it lives no longer than the body: the raw
-- purge clears both in one update (lib/amux/ideaRawRetentionService.ts), and
-- the CHECK below refuses a title on a purged row.

-- AlterTable
ALTER TABLE "AmuxIdeaSubmission" ADD COLUMN "title" TEXT;

ALTER TABLE "AmuxIdeaSubmission" ADD CONSTRAINT "AmuxIdeaSubmission_title_check" CHECK (
    "title" IS NULL OR (
        "rawPurgedAt" IS NULL AND "rawCiphertext" IS NOT NULL AND
        char_length("title") BETWEEN 1 AND 80
    )
);

-- Backfill only ideas sent from a product-research suggestion: that row keeps
-- the plaintext title the idea's first line was made from (suggestionIdeaText,
-- lib/productResearchScoutCore.ts). Same rule as amuxIdeaTitleFromText: first
-- line, control characters and runs of white space to one space, trimmed, cut
-- to 79 characters and an ellipsis past 80. Every other idea stays NULL, and a
-- purged body gets no title.
WITH source AS (
    SELECT DISTINCT ON (s."amuxIdeaId")
        s."amuxIdeaId" AS "ideaId",
        btrim(regexp_replace(
            split_part(replace(s."title", E'\r', E'\n'), E'\n', 1),
            '[[:cntrl:][:space:]]+', ' ', 'g')) AS "title"
    FROM "ProductResearchSuggestion" s
    WHERE s."amuxIdeaId" IS NOT NULL
    ORDER BY s."amuxIdeaId", s."createdAt" ASC, s."id" ASC
)
UPDATE "AmuxIdeaSubmission" i
SET "title" = CASE WHEN char_length(source."title") > 80
        THEN rtrim(left(source."title", 79)) || '…'
        ELSE source."title" END
FROM source
WHERE i."id" = source."ideaId"
  AND i."title" IS NULL
  AND i."rawPurgedAt" IS NULL
  AND i."rawCiphertext" IS NOT NULL
  AND source."title" <> '';
