-- The order key of the last provider event applied to a delivery, and the
-- time of its latest soft bounce, so provider events processed in any order end
-- in the same state.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
-- (event order, C71, C77, C85).
--
-- Nullable additions only: existing rows have no ordered event yet, and the
-- first event after this deploy sets the key. The CHECK is added NOT VALID and
-- validated in its own statement, so existing rows are scanned under
-- VALIDATE's lighter lock rather than the ADD's.

ALTER TABLE "EmailDelivery"
    ADD COLUMN "providerEventAt" TIMESTAMP(3),
    ADD COLUMN "providerEventRank" INTEGER,
    ADD COLUMN "providerEventId" TEXT,
    ADD COLUMN "softBounceAt" TIMESTAMP(3);

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_provider_event_key_check"
    CHECK (
        ("providerEventAt" IS NULL AND "providerEventRank" IS NULL AND "providerEventId" IS NULL)
        OR ("providerEventAt" IS NOT NULL AND "providerEventRank" BETWEEN 0 AND 4
            AND "providerEventId" IS NOT NULL)
    ) NOT VALID;

ALTER TABLE "EmailDelivery" VALIDATE CONSTRAINT "EmailDelivery_provider_event_key_check";

-- Deliveries whose events arrived before this change get their key from the
-- events already on file, so a late event after the deploy is compared with
-- the real latest event rather than overwriting it. The status is set to the
-- one that event implies: the previous build applied events in arrival order,
-- which is exactly what this change stops depending on. Only processed events
-- count -- a failed one changed nothing then either. Events older than the
-- ninety-day retention are gone, and so is any chance of a late event for
-- those deliveries.
--
-- The event time follows lib/emailProviderEventOrderCore.ts: created_at when it
-- parses and is at most five minutes after receipt, else receipt; truncated to
-- milliseconds as a JavaScript Date is.

CREATE FUNCTION pg_temp.email_event_time(created TEXT, received TIMESTAMP(3))
RETURNS TIMESTAMP(3) AS $$
DECLARE
    parsed TIMESTAMP(3);
BEGIN
    IF created IS NULL OR created !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' THEN
        RETURN received;
    END IF;
    BEGIN
        parsed := date_trunc('milliseconds', created::timestamptz AT TIME ZONE 'UTC');
    EXCEPTION WHEN others THEN
        RETURN received;
    END;
    IF parsed > received + interval '5 minutes' THEN
        RETURN received;
    END IF;
    RETURN parsed;
END;
$$ LANGUAGE plpgsql;

WITH ev AS (
    SELECT
        d."id" AS delivery_id,
        pg_temp.email_event_time(e."payload"->>'created_at', e."receivedAt") AS at,
        CASE e."eventType"
            WHEN 'email.sent' THEN 0
            WHEN 'email.delivered' THEN 1
            WHEN 'email.delivery_delayed' THEN 2
            WHEN 'email.bounced' THEN
                CASE WHEN lower(COALESCE(e."payload"->'data'->'bounce'->>'type', '')) = 'hard'
                     THEN 3 ELSE 2 END
            WHEN 'email.complained' THEN 4
        END AS rank,
        e."providerEventId" AS event_id
    FROM "ProviderWebhookEvent" AS e
    JOIN "EmailDelivery" AS d
      ON d."providerMessageId" = e."payload"->'data'->>'email_id'
    WHERE e."provider" = 'resend'
      AND e."processedAt" IS NOT NULL
      AND e."eventType" IN (
          'email.sent', 'email.delivered', 'email.delivery_delayed',
          'email.bounced', 'email.complained'
      )
      AND jsonb_typeof(e."payload"->'data') = 'object'
),
latest AS (
    SELECT DISTINCT ON (delivery_id) delivery_id, at, rank, event_id
    FROM ev
    ORDER BY delivery_id, at DESC, rank DESC, event_id COLLATE "C" DESC
),
soft AS (
    SELECT delivery_id, max(at) AS at FROM ev WHERE rank = 2 GROUP BY delivery_id
),
delivered AS (
    SELECT delivery_id, max(at) AS at FROM ev WHERE rank = 1 GROUP BY delivery_id
)
UPDATE "EmailDelivery" AS d
   SET "providerEventAt" = l.at,
       "providerEventRank" = l.rank,
       "providerEventId" = l.event_id,
       "status" = CASE
           WHEN d."status" IN ('sent', 'delivered', 'bounced', 'complained') THEN
               CASE l.rank WHEN 0 THEN 'sent' WHEN 1 THEN 'delivered' WHEN 4 THEN 'complained' ELSE 'bounced' END
           ELSE d."status"
       END,
       "lastErrorKind" = CASE
           WHEN d."status" IN ('sent', 'delivered', 'bounced', 'complained') THEN
               CASE WHEN l.rank = 2 THEN 'soft_bounce' ELSE NULL END
           ELSE d."lastErrorKind"
       END,
       "softBounceAt" = s.at,
       "deliveredAt" = COALESCE(dl.at, d."deliveredAt")
  FROM latest AS l
  LEFT JOIN soft AS s ON s.delivery_id = l.delivery_id
  LEFT JOIN delivered AS dl ON dl.delivery_id = l.delivery_id
 WHERE d."id" = l.delivery_id;
