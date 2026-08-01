ALTER TABLE "UserSettings"
ADD COLUMN "preferredTasks" JSONB,
ADD COLUMN "preferredPriority" TEXT,
ADD COLUMN "usesFilesFrequently" TEXT,
ADD COLUMN "modelFinderCompletedAt" TIMESTAMP(3);

-- Existing accounts keep their current onboarding state. They can opt in from
-- Settings, while accounts created after launch are eligible for the A/B test.
UPDATE "UserSettings"
SET "modelFinderCompletedAt" = NOW()
WHERE "modelFinderCompletedAt" IS NULL;

ALTER TABLE "ProductAnalyticsEvent"
DROP CONSTRAINT "ProductAnalyticsEvent_name_check";

ALTER TABLE "ProductAnalyticsEvent"
ADD CONSTRAINT "ProductAnalyticsEvent_name_check"
CHECK ("eventName" IN (
  'landing_view',
  'cta_start_click',
  'pricing_view',
  'plan_selected',
  'chat_started',
  'first_response_completed',
  'multi_model_compare_completed',
  'followup_sent',
  'file_attached',
  'conversation_saved',
  'share_created',
  'signup_started',
  'signup_completed',
  'signup_page_view',
  'onboarding_shown',
  'onboarding_completed',
  'onboarding_skipped',
  'credit_limit_hit',
  'upgrade_prompt_view',
  'checkout_started',
  'checkout_failed',
  'purchase_completed',
  'return_day_1',
  'return_day_7',
  'subscription_cancelled',
  'model_finder_viewed',
  'model_finder_started',
  'model_finder_completed',
  'model_finder_skipped',
  'recommended_model_accepted',
  'recommended_model_changed',
  'advanced_model_suggested',
  'advanced_model_selected'
));
