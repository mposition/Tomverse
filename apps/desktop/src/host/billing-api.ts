import type { AccountSettingsApi, SettingsRequest } from "./account-settings-api";
import {
  billingErrorCode, desktopBillingResponse, stripeCheckoutUrl,
  type BillingAction, type BillingResult, type BillingServerAction, type CheckoutPurpose, type DesktopBillingInput,
} from "../billing-contract";

type ServerInput = Extract<DesktopBillingInput, { action: BillingServerAction }>;

/** Stripe calls behind these routes take longer than an account settings read. */
const PROVIDER_TIMEOUT_MS = 30_000;
const providerActions = new Set<BillingAction>(["checkout", "buyCreditPack", "previewPlanChange", "confirmPlanChange",
  "cancelPlanChange", "cancelSubscription"]);

/** The web's own billing request for each action; the renderer never supplies a path. */
export function billingRequest(input: ServerInput, timeZone: string | null): SettingsRequest {
  const market = timeZone ? "?" + new URLSearchParams({ tz: timeZone }).toString() : "";
  switch (input.action) {
    case "usage":
      return { path: "/api/user/usage" };
    case "config":
      return { path: "/api/billing/config" + market };
    case "creditPacks":
      return { path: "/api/billing/credit-packs" + market };
    case "planChange":
      return { path: "/api/billing/plan-change" };
    case "refundStatus":
      return { path: "/api/billing/refund-request" };
    case "validatePromotion":
      return { path: "/api/billing/promotion/validate", method: "POST", body: {
        planId: input.planId, billingInterval: input.billingInterval, promoCode: input.promoCode, currency: input.currency,
      } };
    case "checkout":
      return { path: "/api/billing/checkout", method: "POST", body: {
        planId: input.planId, billingInterval: input.billingInterval, language: input.language, currency: input.currency,
        purchaseAttemptId: input.purchaseAttemptId, ...(input.promoCode ? { promoCode: input.promoCode } : {}),
      } };
    case "buyCreditPack":
      return { path: "/api/billing/credit-packs", method: "POST", body: {
        packId: input.packId, language: input.language, currency: input.currency,
      } };
    case "previewPlanChange":
      return { path: "/api/billing/plan-change/preview", method: "POST", body: {
        targetTier: input.targetTier, billingInterval: input.billingInterval,
      } };
    case "confirmPlanChange":
      return { path: "/api/billing/plan-change/confirm", method: "POST", body: {
        requestId: input.requestId, ...(input.resumeRenewal ? { resumeRenewal: true } : {}),
      } };
    case "cancelPlanChange":
      return { path: "/api/billing/plan-change", method: "DELETE" };
    case "cancelSubscription":
      return { path: "/api/billing/cancel-subscription", method: "POST", body: {} };
    case "requestRefund":
      return { path: "/api/billing/refund-request", method: "POST", body: { reason: input.reason } };
  }
}

/**
 * Desktop billing over the account settings session. The checkout page itself is
 * opened by `openCheckout` in a separate isolated window that never receives the
 * session; this module only ever talks to Tomverse.
 */
export function createBillingApi(settings: Pick<AccountSettingsApi, "send" | "forget">, deps: {
  accountSignal: AbortSignal;
  timeZone: () => string | null;
  checkoutOpen: () => boolean;
  openCheckout: (url: URL, purpose: CheckoutPurpose) => void;
}) {
  type Failure = Extract<BillingResult<BillingAction>, { ok: false }>;

  async function call(input: ServerInput): Promise<{ ok: true; value: unknown } | Failure> {
    let response: Response;
    try {
      response = await settings.send(billingRequest(input, deps.timeZone()), "application/json",
        providerActions.has(input.action) ? PROVIDER_TIMEOUT_MS : undefined);
    } catch {
      deps.accountSignal.throwIfAborted();
      // For a write this is an unknown outcome: the screen re-reads the account before it offers the action again.
      return { ok: false, status: 0, code: "NETWORK_ERROR" };
    }
    const body: unknown = await response.json().catch(() => null);
    deps.accountSignal.throwIfAborted();
    if (!response.ok) {
      if (response.status === 401) settings.forget();
      return { ok: false, status: response.status, code: billingErrorCode(body) };
    }
    const parsed = desktopBillingResponse[input.action].safeParse(body);
    if (!parsed.success) return { ok: false, status: response.status, code: "INVALID_RESPONSE" };
    return { ok: true, value: parsed.data };
  }

  async function startCheckout(
    input: Extract<ServerInput, { action: "checkout" | "buyCreditPack" }>,
  ): Promise<BillingResult<"checkout">> {
    // A second Session while one checkout window is open would be a second purchase attempt.
    if (deps.checkoutOpen()) return { ok: false, status: 0, code: "CHECKOUT_WINDOW_OPEN" };
    const result = await call(input);
    if (!result.ok) return result;
    const value = result.value as { url: string } | { periodEnd: string };
    if (!("url" in value)) {
      return input.action === "checkout" ? { ok: true, value: { kind: "pass", periodEnd: value.periodEnd } }
        : { ok: false, status: 200, code: "INVALID_RESPONSE" };
    }
    const target = stripeCheckoutUrl(value.url);
    if (!target) return { ok: false, status: 200, code: "CHECKOUT_URL_REJECTED" };
    deps.accountSignal.throwIfAborted();
    deps.openCheckout(target, input.action === "checkout" ? "subscription" : "credits");
    return { ok: true, value: { kind: "window" } };
  }

  return async function billing(input: ServerInput): Promise<{ ok: true; value: unknown } | Failure> {
    deps.accountSignal.throwIfAborted();
    if (input.action === "checkout" || input.action === "buyCreditPack") return startCheckout(input);
    return call(input);
  };
}

export type BillingApi = ReturnType<typeof createBillingApi>;
