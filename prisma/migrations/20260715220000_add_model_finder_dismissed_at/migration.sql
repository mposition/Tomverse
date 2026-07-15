ALTER TABLE "UserSettings"
ADD COLUMN "modelFinderDismissedAt" TIMESTAMP(3);

-- Recover only high-confidence historical "later" choices. The previous
-- implementation wrote modelFinderCompletedAt immediately before recording
-- the matching analytics event. A ten-minute proximity guard avoids
-- reopening accounts that subsequently completed the finder.
WITH latest_later AS (
  SELECT DISTINCT ON ("userId")
    "userId",
    "occurredAt"
  FROM "ProductAnalyticsEvent"
  WHERE "eventName" = 'model_finder_skipped'
    AND "userId" IS NOT NULL
    AND "properties" ->> 'method' = 'later'
  ORDER BY "userId", "occurredAt" DESC
)
UPDATE "UserSettings" AS settings
SET
  "modelFinderDismissedAt" = settings."modelFinderCompletedAt",
  "modelFinderCompletedAt" = NULL
FROM latest_later
WHERE settings."userId" = latest_later."userId"
  AND settings."modelFinderCompletedAt" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "ProductAnalyticsEvent" AS later_completion
    WHERE later_completion."userId" = latest_later."userId"
      AND later_completion."occurredAt" >= latest_later."occurredAt"
      AND (
        later_completion."eventName" = 'model_finder_completed'
        OR (
          later_completion."eventName" = 'recommended_model_accepted'
          AND later_completion."properties" ->> 'method' = 'default'
        )
      )
  )
  AND ABS(
    EXTRACT(
      EPOCH FROM (settings."modelFinderCompletedAt" - latest_later."occurredAt")
    )
  ) <= 600;
