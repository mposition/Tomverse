-- The order key of the last provider event applied to a delivery, and the
-- time of its latest soft bounce, so provider events processed in any order end
-- in the same state.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
-- (event order, C71, C77, C85).
--
-- Nullable additions only: existing rows have no ordered event yet, and the
-- first event after this deploy sets the key.

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
    );
