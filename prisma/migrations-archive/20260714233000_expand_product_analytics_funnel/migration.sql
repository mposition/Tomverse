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
  'subscription_cancelled'
));
