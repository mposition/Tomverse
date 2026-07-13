import { z } from "zod";

export const PRODUCT_ANALYTICS_EVENT_NAMES = [
  "landing_view",
  "cta_start_click",
  "chat_started",
  "first_response_completed",
  "multi_model_compare_completed",
  "followup_sent",
  "file_attached",
  "conversation_saved",
  "share_created",
  "signup_started",
  "signup_completed",
  "checkout_started",
  "purchase_completed",
  "return_day_1",
  "return_day_7",
  "subscription_cancelled",
] as const;

export type ProductAnalyticsEventName =
  (typeof PRODUCT_ANALYTICS_EVENT_NAMES)[number];

export const analyticsPropertiesSchema = z
  .object({
    cta_location: z.string().trim().min(1).max(64).optional(),
    method: z.string().trim().min(1).max(32).optional(),
    attachment_count: z.number().int().min(1).max(5).optional(),
    model_id: z.string().trim().min(1).max(80).optional(),
    billing_interval: z.enum(["monthly", "annual"]).optional(),
    plan_id: z.enum(["free", "pro", "max"]).optional(),
    value: z.number().finite().min(0).max(1_000_000).optional(),
    currency: z.literal("USD").optional(),
    transaction_id: z.string().trim().min(1).max(100).optional(),
    conversation_mode: z.enum(["guest", "account", "private"]).optional(),
  })
  .strict();

export type ProductAnalyticsProperties = z.infer<
  typeof analyticsPropertiesSchema
>;

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
