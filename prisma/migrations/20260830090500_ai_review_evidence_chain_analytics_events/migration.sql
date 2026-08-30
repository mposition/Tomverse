-- AI Review evidence-chain and day-30 retention analytics events.
--
-- docs/policy/ai-review-m5-quality-contract.md §9, and
-- docs/ui-contracts/ai-review-evidence-chain.md.
--
-- Three names. `comparison_review_item_verified` is the step past the review
-- itself -- the separate per-item web check the user asks for on one claim.
-- `comparison_review_item_feedback` is the user's own verdict on one review
-- item. `return_day_30` completes the retention series the value question is
-- asked in; day 1 and day 7 were already here and day 30 was the missing one.
--
-- The event-name check is a closed list mirroring PRODUCT_ANALYTICS_EVENT_NAMES
-- in lib/productAnalyticsShared.ts; recreating it is how new names land
-- (tests/productAnalyticsDatabaseConstraint.test.ts keeps the two in step).
--
-- Content-free by schema. The verification event carries the check's own
-- closed status and never its summary sentence, which is model prose about the
-- user's question. The feedback event carries a closed verdict and a closed
-- section name, and deliberately NOT the review item's id: a set of per-review
-- ids beside timestamps narrows a small population toward one conversation,
-- and the properties schema is strict, so there is no key for one to travel
-- in. The item a verdict is about is identified only inside the account's own
-- feedback row.
--
-- Additive and reversible by the same shape: the constraint is dropped and
-- recreated, no row is read or written, and the previous list is one migration
-- back if it ever has to be restored.
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
  'comparison_review_viewed',
  'comparison_review_started',
  'comparison_review_completed',
  'comparison_review_failed',
  'comparison_review_item_verified',
  'comparison_review_item_feedback',
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
  'promotion_pass_activated',
  'return_day_1',
  'return_day_7',
  'return_day_30',
  'subscription_cancelled',
  'model_finder_viewed',
  'model_finder_started',
  'model_finder_completed',
  'model_finder_skipped',
  'recommended_model_accepted',
  'recommended_model_changed',
  'advanced_model_suggested',
  'advanced_model_selected',
  'help_opened',
  'help_article_viewed',
  'ui_help_opened',
  'sidebar_tour_started',
  'sidebar_tour_completed',
  'sidebar_tour_skipped',
  'chat_tool_menu_opened',
  'model_picker_opened',
  'model_picker_all_opened',
  'model_picker_search_used',
  'model_picker_filter_opened',
  'model_picker_filter_applied',
  'model_picker_selection_confirmed',
  'model_picker_max_reached',
  'model_picker_abandoned',
  'web_search_mode_selected',
  'web_search_suggestion_shown',
  'web_search_suggestion_accepted',
  'web_search_suggestion_declined',
  'deep_research_setup_opened',
  'deep_research_started',
  'deep_research_cancelled',
  'deep_research_completed',
  'deep_research_failed',
  'answer_sources_opened',
  'web_search_native_executed',
  'web_search_native_unsupported',
  'web_search_native_failed',
  'web_search_native_not_executed',
  'marketing_language_switched',
  'credit_pack_cta_view',
  'credit_pack_cta_click',
  'credit_pack_selected',
  'authentication_required',
  'purchase_intent_resumed',
  'checkout_cancelled',
  'external_import_parse_completed',
  'external_import_parse_failed',
  'external_import_desktop_recommended',
  'external_import_finalized',
  'external_import_step_entered',
  'external_import_step_abandoned',
  'assistant_profile_create_started',
  'assistant_profile_create_completed',
  'assistant_profile_applied_to_chat',
  'assistant_package_import_step_entered',
  'assistant_package_import_step_abandoned',
  'assistant_package_import_warning',
  'assistant_package_import_completed',
  'image_intent_suggestion_shown',
  'image_intent_suggestion_accepted',
  'image_intent_suggestion_dismissed',
  'deep_research_suggestion_shown',
  'deep_research_suggestion_accepted',
  'deep_research_suggestion_dismissed'
));
