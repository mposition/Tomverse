import { z } from "zod";
import { BILLING_CURRENCIES, type BillingCurrency } from "@/lib/billingMarkets";

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
    trigger: purchaseAnalyticsTriggerSchema.optional(),
    plan_credits_remaining: z.number().int().min(0).max(1_000_000).optional(),
    addon_credits_remaining: z.number().int().min(0).max(1_000_000).optional(),
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
      .enum(["promotion_validation", "checkout_session"])
      .optional(),
    error_code: z
      .enum([
        "promotion_invalid",
        "network_error",
        "checkout_request_failed",
      ])
      .optional(),
    market_tier: z.enum(["primary", "limited", "preview"]).optional(),
    paid_marketing_eligible: z.boolean().optional(),
    experiment_variant: z.enum(["control", "finder"]).optional(),
    recommendation_rank: z.number().int().min(1).max(3).optional(),
    suggestion_reason: z.enum(["document", "deep_analysis", "research"]).optional(),
    review_mode: z.enum(["balanced", "evidence", "action"]).optional(),
    cached: z.boolean().optional(),
    usage_credits: z.number().int().min(0).max(100).optional(),
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
