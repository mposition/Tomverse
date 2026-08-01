ALTER TABLE "User" ADD COLUMN "createdAt" TIMESTAMP(3);
ALTER TABLE "User" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "ProductAnalyticsEvent" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousIdHash" TEXT NOT NULL,
    "sessionIdHash" TEXT NOT NULL,
    "utmSource" TEXT NOT NULL,
    "utmMedium" TEXT NOT NULL,
    "utmCampaign" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "modelCount" INTEGER NOT NULL,
    "plan" TEXT NOT NULL,
    "properties" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAnalyticsEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductAnalyticsEvent_source_check"
      CHECK ("source" IN ('client', 'server')),
    CONSTRAINT "ProductAnalyticsEvent_name_check"
      CHECK ("eventName" IN (
        'landing_view',
        'cta_start_click',
        'chat_started',
        'first_response_completed',
        'multi_model_compare_completed',
        'followup_sent',
        'file_attached',
        'conversation_saved',
        'share_created',
        'signup_started',
        'signup_completed',
        'checkout_started',
        'purchase_completed',
        'return_day_1',
        'return_day_7',
        'subscription_cancelled'
      )),
    CONSTRAINT "ProductAnalyticsEvent_modelCount_check"
      CHECK ("modelCount" BETWEEN 0 AND 3),
    CONSTRAINT "ProductAnalyticsEvent_language_check"
      CHECK ("language" IN ('en', 'ko', 'zh', 'fr', 'de', 'es', 'pt')),
    CONSTRAINT "ProductAnalyticsEvent_country_check"
      CHECK ("country" ~ '^[A-Z]{2}$'),
    CONSTRAINT "ProductAnalyticsEvent_plan_check"
      CHECK ("plan" IN ('Guest', 'Free', 'Pro', 'Max'))
);

CREATE UNIQUE INDEX "ProductAnalyticsEvent_dedupeKey_key"
ON "ProductAnalyticsEvent"("dedupeKey");

CREATE INDEX "ProductAnalyticsEvent_eventName_occurredAt_idx"
ON "ProductAnalyticsEvent"("eventName", "occurredAt");

CREATE INDEX "ProductAnalyticsEvent_userId_occurredAt_idx"
ON "ProductAnalyticsEvent"("userId", "occurredAt");

CREATE INDEX "ProductAnalyticsEvent_anonymousIdHash_occurredAt_idx"
ON "ProductAnalyticsEvent"("anonymousIdHash", "occurredAt");

CREATE INDEX "ProductAnalyticsEvent_utmSource_utmCampaign_occurredAt_idx"
ON "ProductAnalyticsEvent"("utmSource", "utmCampaign", "occurredAt");

ALTER TABLE "ProductAnalyticsEvent"
ADD CONSTRAINT "ProductAnalyticsEvent_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
