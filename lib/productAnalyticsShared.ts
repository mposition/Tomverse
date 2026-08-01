import { z } from "zod";
import { BILLING_CURRENCIES, type BillingCurrency } from "@/lib/billingMarkets";
import { SUPPORTED_LANGUAGES } from "@/lib/language";

export const PRODUCT_ANALYTICS_EVENT_NAMES = [
  "landing_view",
  "cta_start_click",
  "pricing_view",
  "plan_selected",
  "chat_started",
  "first_response_completed",
  "multi_model_compare_completed",
  "comparison_review_viewed",
  "comparison_review_started",
  "comparison_review_completed",
  "comparison_review_failed",
  "followup_sent",
  "file_attached",
  "conversation_saved",
  "share_created",
  "signup_started",
  "signup_completed",
  "signup_page_view",
  "onboarding_shown",
  "onboarding_completed",
  "onboarding_skipped",
  "credit_limit_hit",
  "upgrade_prompt_view",
  "checkout_started",
  "checkout_failed",
  "purchase_completed",
  "promotion_pass_activated",
  "return_day_1",
  "return_day_7",
  "subscription_cancelled",
  "model_finder_viewed",
  "model_finder_started",
  "model_finder_completed",
  "model_finder_skipped",
  "recommended_model_accepted",
  "recommended_model_changed",
  "advanced_model_suggested",
  "advanced_model_selected",
  "help_opened",
  "help_article_viewed",
  "ui_help_opened",
  "sidebar_tour_started",
  "sidebar_tour_completed",
  "sidebar_tour_skipped",
  "chat_tool_menu_opened",
  "model_picker_opened",
  "model_picker_all_opened",
  "model_picker_search_used",
  "model_picker_filter_opened",
  "model_picker_filter_applied",
  "model_picker_selection_confirmed",
  "model_picker_max_reached",
  "model_picker_abandoned",
  "web_search_mode_selected",
  "web_search_suggestion_shown",
  "web_search_suggestion_accepted",
  "web_search_suggestion_declined",
  "deep_research_setup_opened",
  "deep_research_started",
  "deep_research_cancelled",
  "deep_research_completed",
  "deep_research_failed",
  "answer_sources_opened",
  "web_search_native_executed",
  "web_search_native_unsupported",
  "web_search_native_failed",
  // Requested on a native-capable model, but the provider chose not to
  // search this turn -- distinct from unsupported/failed. Always paired
  // with a full surcharge refund (see getSettledUsageCredits).
  "web_search_native_not_executed",
  // RECON-I18N-001. The localized marketing routes have their own root layout,
  // so switching language from an English page is a document navigation rather
  // than a client one -- about 2x slower, and 2.6s slower on a mid-tier phone
  // over 4G. Keeping that cost was decided on the structural argument that the
  // path is rare (Korean traffic lands on /ko from search, and /chat resolves
  // Accept-Language), with nothing measuring whether that is true. This event
  // is the missing input: `navigation` says whether a given switch actually
  // crossed a root boundary and paid for it.
  "marketing_language_switched",
  // The credit-pack purchase funnel. Before these, the only thing measurable
  // between "someone opened /pricing" and "Stripe redirected them back" was
  // `checkout_started`, which the pricing page never reached: its add-on CTA
  // was a link to /chat. A drop-off at the CTA, at the sign-in round trip, or
  // at pack selection all looked identical -- like nobody wanting credits.
  "credit_pack_cta_view",
  "credit_pack_cta_click",
  "credit_pack_selected",
  // The visitor was asked to sign in before a purchase could continue. Paired
  // with `purchase_intent_resumed`, which fires when they come back and the
  // intent is still intact, so an intent lost in the round trip is visible as
  // the gap between the two.
  "authentication_required",
  "purchase_intent_resumed",
  // Stripe sent the visitor back through `cancel_url`. Distinct from
  // `checkout_failed`: nothing went wrong, they chose not to buy.
  "checkout_cancelled",
] as const;

export type ProductAnalyticsEventName =
  (typeof PRODUCT_ANALYTICS_EVENT_NAMES)[number];

export const shouldSendCustomProductEventToGa4 = (
  eventName: ProductAnalyticsEventName
) => eventName !== "purchase_completed";

export const isGa4DebugModeEnabled = (value: unknown) =>
  typeof value === "string" && value.trim().toLowerCase() === "true";

export const ga4DebugEventParams = (value: unknown) =>
  isGa4DebugModeEnabled(value) ? ({ debug_mode: true } as const) : {};

export const PURCHASE_ANALYTICS_TRIGGERS = [
  "limit_hit",
  "usage_widget",
  "account",
  "proactive",
] as const;

export const purchaseAnalyticsTriggerSchema = z.enum(
  PURCHASE_ANALYTICS_TRIGGERS
);

export type PurchaseAnalyticsTrigger = z.infer<
  typeof purchaseAnalyticsTriggerSchema
>;

export const normalizePurchaseAnalyticsTrigger = (
  value: unknown,
  fallback: PurchaseAnalyticsTrigger = "proactive"
) => purchaseAnalyticsTriggerSchema.safeParse(value).data || fallback;

export const analyticsPropertiesSchema = z
  .object({
    cta_location: z.string().trim().min(1).max(64).optional(),
    method: z.string().trim().min(1).max(32).optional(),
    attachment_count: z.number().int().min(1).max(5).optional(),
    model_id: z.string().trim().min(1).max(80).optional(),
    billing_interval: z.enum(["monthly", "annual"]).optional(),
    plan_id: z.enum(["free", "pro", "max"]).optional(),
    purchase_type: z.enum(["subscription", "credit_pack"]).optional(),
    product_id: z.string().trim().min(1).max(80).optional(),
    pack_id: z.string().trim().min(1).max(32).optional(),
    credits_purchased: z.number().int().min(0).max(1_000_000).optional(),
    monthly_credits_included: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional(),
    current_plan: z.enum(["free", "pro", "max"]).optional(),
    // What the visitor is trying to move to, which is not always a plan card:
    // a credit-pack purchase leaves `current_plan` unchanged, so `plan_id`
    // alone could not distinguish "wants Max" from "stays on Pro, buys credits".
    target_plan: z.enum(["free", "pro", "max"]).optional(),
    // Whether the session was resolved, and to what, at the moment the event
    // fired. The reported defect -- a signed-in visitor being shown "Sign in to
    // buy credits" -- was invisible in analytics precisely because no event
    // recorded which side of the auth boundary the CTA believed it was on.
    authentication_state: z
      .enum(["loading", "authenticated", "unauthenticated"])
      .optional(),
    trigger: purchaseAnalyticsTriggerSchema.optional(),
    plan_credits_remaining: z.number().int().min(0).max(1_000_000).optional(),
    addon_credits_remaining: z.number().int().min(0).max(1_000_000).optional(),
    daily_plan_credits_remaining: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .nullable()
      .optional(),
    required_credits: z.number().int().min(0).max(1_000_000).optional(),
    reset_at: z.string().datetime().optional(),
    value: z.number().finite().min(0).max(1_000_000).optional(),
    currency: z.enum(BILLING_CURRENCIES).optional(),
    transaction_id: z.string().trim().min(1).max(100).optional(),
    promotion_code: z.string().trim().min(1).max(32).optional(),
    access_duration_days: z.number().int().min(1).max(366).optional(),
    automatic_renewal: z.boolean().optional(),
    conversation_mode: z.enum(["guest", "account", "private"]).optional(),
    onboarding_id: z.string().trim().min(1).max(32).optional(),
    limit_scope: z.enum(["guest", "daily", "monthly"]).optional(),
    failure_stage: z
      .enum([
        "promotion_validation",
        "checkout_session",
        // Loading the account's eligible packs, which is a separate failure
        // from creating the session: a 401 here means the visitor never got to
        // choose, and the recovery is re-authentication rather than a retry.
        "credit_pack_load",
      ])
      .optional(),
    // Mirrors BILLING_ERROR_CODES in lib/purchaseIntent.ts, lower-cased to
    // match the rest of this schema. Keeping the two in step is what lets a
    // funnel drop-off be attributed to an expired session rather than being
    // pooled into one "checkout failed" bucket.
    error_code: z
      .enum([
        "promotion_invalid",
        "network_error",
        "checkout_request_failed",
        "authentication_required",
        "session_expired",
        "pack_not_available_for_plan",
        "checkout_configuration_error",
        "billing_market_mismatch",
        "active_subscription_exists",
        "plan_change_not_supported",
        "checkout_rate_limited",
        "unknown_error",
      ])
      .optional(),
    market_tier: z.enum(["primary", "limited", "preview"]).optional(),
    paid_marketing_eligible: z.boolean().optional(),
    experiment_variant: z.enum(["control", "finder"]).optional(),
    // The picker's recommended screen shows up to 8 cards (STG-F008); the
    // onboarding Model Finder still only ever emits ranks 1-3.
    recommendation_rank: z.number().int().min(1).max(8).optional(),
    suggestion_reason: z.enum(["document", "deep_analysis", "research"]).optional(),
    review_mode: z.enum(["balanced", "evidence", "action"]).optional(),
    // Bucketed exact-quote-match rate for a comparison review (the value the
    // UI shows as "Source grounding"). It is stored under the legacy
    // `confidence` field name, so the analytics property is named for what it
    // measures to keep it from being reported as model confidence.
    // "not_available" means the review contained no quotes to match at all.
    source_grounding_level: z
      .enum(["low", "medium", "high", "not_available"])
      .optional(),
    cached: z.boolean().optional(),
    usage_credits: z.number().int().min(0).max(100).optional(),
    help_source: z
      .enum(["sidebar_header", "help_centre", "workspace_guide"])
      .optional(),
    help_topic: z
      .enum([
        "workspace",
        "project",
        "label",
        "labels",
        "locked",
        "shared",
        "private",
        "ai_review",
        "credits",
        "guest_trial",
      ])
      .optional(),
    help_article_id: z.enum(["chat_workspace"]).optional(),
    web_search_mode: z.enum(["off", "auto", "always"]).optional(),
    deep_research_depth: z.enum(["quick", "standard", "deep"]).optional(),
    search_provider: z
      .enum(["openai", "anthropic", "google", "perplexity"])
      .optional(),
    // Language the visitor switched away from / to. `language` already exists
    // as an attribution field, but it records the language at send time, which
    // for a switch is only half the story.
    language_from: z.enum(SUPPORTED_LANGUAGES).optional(),
    language_to: z.enum(SUPPORTED_LANGUAGES).optional(),
    // "document" when the switch crossed the (site)/[locale] root boundary and
    // reloaded, "client" when it stayed in the same document.
    navigation: z.enum(["document", "client"]).optional(),
  })
  .strict()
  .superRefine((properties, context) => {
    if (
      properties.purchase_type === "subscription" &&
      properties.credits_purchased !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["credits_purchased"],
        message:
          "Subscription events must use monthly_credits_included instead of credits_purchased.",
      });
    }
    if (
      properties.purchase_type === "credit_pack" &&
      properties.monthly_credits_included !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["monthly_credits_included"],
        message:
          "Credit-pack events must use credits_purchased instead of monthly_credits_included.",
      });
    }
  });

export type ProductAnalyticsProperties = z.infer<
  typeof analyticsPropertiesSchema
>;

export type Ga4EcommerceEvent = {
  name: "begin_checkout" | "purchase";
  params: {
    transaction_id?: string;
    value: number;
    currency: BillingCurrency;
    purchase_type: "subscription" | "credit_pack";
    product_id: string;
    current_plan?: "free" | "pro" | "max";
    trigger?: PurchaseAnalyticsTrigger;
    monthly_credits_included?: number;
    credits_purchased?: number;
    items: [
      {
        item_id: string;
        item_name: string;
        affiliation: "Tomverse";
        item_brand: "Tomverse";
        item_category: "Subscription" | "Credit pack";
        item_variant?: string;
        price: number;
        quantity: 1;
      },
    ];
  };
};

const ga4ItemName = (productId: string) => {
  const names: Record<string, string> = {
    subscription_pro_monthly: "Tomverse Pro monthly",
    subscription_pro_annual: "Tomverse Pro annual",
    subscription_max_monthly: "Tomverse Max monthly",
    subscription_max_annual: "Tomverse Max annual",
    starter_500: "Starter Credit Pack",
    project_1500: "Project Credit Pack",
    power_4000: "Power Credit Pack",
  };
  return names[productId] || productId;
};

export const ga4EcommerceEventForProductEvent = (
  eventName: ProductAnalyticsEventName,
  properties: ProductAnalyticsProperties
): Ga4EcommerceEvent | null => {
  if (eventName !== "checkout_started" && eventName !== "purchase_completed") {
    return null;
  }
  if (
    !properties.purchase_type ||
    !properties.product_id ||
    !properties.currency ||
    typeof properties.value !== "number"
  ) {
    return null;
  }
  if (eventName === "purchase_completed" && !properties.transaction_id) {
    return null;
  }

  const itemVariant =
    properties.purchase_type === "subscription"
      ? properties.billing_interval
      : properties.plan_id;

  return {
    name: eventName === "checkout_started" ? "begin_checkout" : "purchase",
    params: {
      ...(properties.transaction_id
        ? { transaction_id: properties.transaction_id }
        : {}),
      value: properties.value,
      currency: properties.currency,
      purchase_type: properties.purchase_type,
      product_id: properties.product_id,
      ...(properties.current_plan
        ? { current_plan: properties.current_plan }
        : {}),
      ...(properties.trigger ? { trigger: properties.trigger } : {}),
      ...(properties.monthly_credits_included !== undefined
        ? { monthly_credits_included: properties.monthly_credits_included }
        : {}),
      ...(properties.credits_purchased !== undefined
        ? { credits_purchased: properties.credits_purchased }
        : {}),
      items: [
        {
          item_id: properties.product_id,
          item_name: ga4ItemName(properties.product_id),
          affiliation: "Tomverse",
          item_brand: "Tomverse",
          item_category:
            properties.purchase_type === "subscription"
              ? "Subscription"
              : "Credit pack",
          ...(itemVariant ? { item_variant: itemVariant } : {}),
          price: properties.value,
          quantity: 1,
        },
      ],
    },
  };
};

export const analyticsAttributionSchema = z
  .object({
    client_id: z.string().uuid(),
    session_id: z.string().regex(/^\d{10,16}$/),
    utm_source: z.string().trim().min(1).max(100),
    utm_medium: z.string().trim().min(1).max(100),
    utm_campaign: z.string().trim().min(1).max(100),
    language: z.enum(["en", "ko", "zh", "fr", "de", "es", "pt"]),
    country: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();

export type AnalyticsAttribution = z.infer<typeof analyticsAttributionSchema>;

export const analyticsClientEventSchema = analyticsAttributionSchema
  .extend({
    event_id: z.string().uuid(),
    event_name: z.enum(PRODUCT_ANALYTICS_EVENT_NAMES),
    occurred_at: z.string().datetime(),
    model_count: z.number().int().min(0).max(3),
    properties: analyticsPropertiesSchema,
  })
  .strict();

export type AnalyticsClientEvent = z.infer<typeof analyticsClientEventSchema>;

export const normalizeAnalyticsPlan = (value: unknown) =>
  value === "Max" || value === "Pro" || value === "Free"
    ? value
    : value === "Guest"
      ? "Guest"
      : "Free";

// The stored consent decision's key. It lives here rather than in
// `productAnalyticsClient` because that module is `"use client"`, and the
// pre-paint reservation script (see MarketingConsentReservation) is rendered by
// a Server Component that has to embed this exact string. One source of truth
// keeps the script and the reader from drifting apart -- a mismatch would
// silently reserve space for visitors who have already decided.
export const ANALYTICS_CONSENT_STORAGE_KEY = "tomverse_analytics_consent_v1";
