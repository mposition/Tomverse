import { z } from "zod";

export type MobileStore = "app_store" | "play_store";
const store = z.enum(["app_store", "play_store"]);
const product = z.discriminatedUnion("kind", [
  z.object({ store, productId: z.string().min(1).max(200), kind: z.literal("subscription"),
    plan: z.enum(["Pro", "Max"]), interval: z.enum(["monthly", "annual"]) }).strict(),
  z.object({ store, productId: z.string().min(1).max(200), kind: z.literal("credits"),
    packId: z.enum(["starter_500", "project_1500", "power_4000"]) }).strict(),
]);
export type MobileBillingProduct = z.infer<typeof product>;
export type MobileBillingState = {
  billingId: string;
  plan: string;
  subscriptionStore: MobileStore | "web" | null;
  productId: string | null;
  interval: string | null;
  expiresAt: string | null;
  cancelAtPeriodEnd: boolean;
  active: boolean;
  purchasedCredits: number;
  webSubscription?: { active: boolean; cancelAtPeriodEnd: boolean; expiresAt: string | null };
  products: (MobileBillingProduct & { credits?: number; monthlyCredits?: number; maxModels?: number })[];
};

export const mobileBillingEnabled = (env = process.env) => env.MOBILE_BILLING_ENABLED === "true";
export const mobileBillingBearerRoutes = () => mobileBillingEnabled() ? ["/api/mobile/billing"] : [];
export const mobileBillingEnvironment = () => process.env.MOBILE_BILLING_ENVIRONMENT === "SANDBOX" ? "SANDBOX" : "PRODUCTION";

export function parseMobileBillingProducts(input: string | undefined): MobileBillingProduct[] {
  const products = z.array(product).min(1).max(30).parse(JSON.parse(input || "[]"));
  const keys = new Set<string>();
  for (const item of products) {
    const key = `${item.store}:${item.productId}`;
    if (keys.has(key)) throw new Error("Duplicate mobile store product.");
    keys.add(key);
  }
  return products;
}

const subscription = z.object({
  store, is_sandbox: z.boolean(), expires_date: z.string().datetime({ offset: true }).nullable(),
  grace_period_expires_date: z.string().datetime({ offset: true }).nullable().optional(),
  refunded_at: z.string().nullable().optional(), unsubscribe_detected_at: z.string().nullable().optional(),
  billing_issues_detected_at: z.string().nullable().optional(),
  product_plan_identifier: z.string().nullable().optional(),
});
export const revenueCatCustomerSchema = z.object({ subscriber: z.object({
  subscriptions: z.record(z.string(), z.unknown()),
}) });

/** Use the current server snapshot, never a client entitlement or webhook snapshot. */
export function resolveMobileSubscription(raw: unknown, products: MobileBillingProduct[], environment: string, now = new Date()) {
  const customer = revenueCatCustomerSchema.parse(raw);
  return Object.entries(customer.subscriber.subscriptions).flatMap(([productId, value]) => {
    const parsed = subscription.safeParse(value);
    if (!parsed.success) return [];
    const current = parsed.data;
    const identifier = current.store === "play_store" && current.product_plan_identifier && !productId.includes(":")
      ? `${productId}:${current.product_plan_identifier}` : productId;
    const item = products.find((p) => p.kind === "subscription" && p.store === current.store && p.productId === identifier);
    if (!item || item.kind !== "subscription" || current.refunded_at || current.is_sandbox !== (environment === "SANDBOX")) return [];
    const expiry = new Date(current.grace_period_expires_date || current.expires_date || 0);
    if (expiry <= now) return [];
    return [{ ...item, expiresAt: expiry, cancelAtPeriodEnd: Boolean(current.unsubscribe_detected_at),
      status: current.billing_issues_detected_at ? "past_due" : "active" }];
  }).sort((a, b) => (b.plan === "Max" ? 1 : 0) - (a.plan === "Max" ? 1 : 0) || b.expiresAt.getTime() - a.expiresAt.getTime())[0] || null;
}

export const mobileBillingRequestSchema = z.object({
  action: z.enum(["sync", "cancel_web"]), store,
}).strict();

export const revenueCatWebhookSchema = z.object({ api_version: z.literal("1.0"), event: z.object({
  id: z.string().min(1).max(200), type: z.string().min(1), app_id: z.string().min(1),
  app_user_id: z.string().min(1).max(200), store: z.enum(["APP_STORE", "PLAY_STORE"]),
  environment: z.enum(["PRODUCTION", "SANDBOX"]), product_id: z.string().min(1).max(200),
  transaction_id: z.string().min(1).max(300), purchased_at_ms: z.number().int().positive(),
  cancel_reason: z.string().optional(),
}) });

export function storeManagementUrl(store: MobileStore) {
  return store === "app_store" ? "https://apps.apple.com/account/subscriptions" : "https://play.google.com/store/account/subscriptions";
}
