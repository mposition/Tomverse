import type { AccountSettingsApi, SettingsRequest } from "./account-settings-api";
import {
  billingErrorCode, desktopBillingResponse, stripeCheckoutUrl,
  type BillingAction, type BillingCreditPacks, type BillingResult, type BillingServerAction, type BillingUsage, type CheckoutOutcome,
  type CheckoutPurpose, type DesktopBillingInput, type PurchaseIntent,
} from "../billing-contract";
import { createPurchaseTracker } from "./purchase-tracker";

type ServerInput = Extract<DesktopBillingInput, { action: BillingServerAction }>;
type ApiInput = ServerInput | Extract<DesktopBillingInput, { action: "checkPurchase" }>;

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
 * session; this module only ever talks to Tomverse. One instance per account
 * session: it also keeps that account's purchase records (`purchase-tracker.ts`).
 */
export function createBillingApi(settings: Pick<AccountSettingsApi, "send" | "forget">, deps: {
  accountSignal: AbortSignal;
  timeZone: () => string | null;
  checkoutOpen: () => boolean;
  openCheckout: (url: URL, purpose: CheckoutPurpose) => void;
  /** The purchase records changed. */
  purchasesChanged?: () => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}) {
  type Failure = Extract<BillingResult<BillingAction>, { ok: false }>;
  // Pack sizes as the server last listed them; they tell which pack a balance increase can be.
  const packCredits = new Map<string, number>();
  const tracker = createPurchaseTracker({
    read: async () => {
      const result = await call({ action: "usage" });
      return result.ok ? result.value as BillingUsage : null;
    },
    changed: () => deps.purchasesChanged?.(),
    signal: deps.accountSignal, now: deps.now, wait: deps.wait,
  });
  let starting = false;

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
    if (input.action === "creditPacks") {
      for (const pack of (parsed.data as BillingCreditPacks).packs) packCredits.set(pack.id, pack.credits);
    }
    return { ok: true, value: parsed.data };
  }

  async function creditsOf(packId: string) {
    if (!packCredits.has(packId)) await call({ action: "creditPacks" });
    return packCredits.get(packId) ?? Infinity;
  }

  async function startCheckout(
    input: Extract<ServerInput, { action: "checkout" | "buyCreditPack" }>,
  ): Promise<BillingResult<"checkout">> {
    // A second Session while one checkout window is open, or being prepared, would be a second purchase attempt.
    if (deps.checkoutOpen() || starting) return { ok: false, status: 0, code: "CHECKOUT_WINDOW_OPEN" };
    starting = true;
    try {
      const intent: PurchaseIntent = input.action === "checkout" ? { kind: "subscription", planId: input.planId }
        : { kind: "credits", packId: input.packId };
      // The account as it is now: the baseline this purchase is confirmed against later, and a fresh look at
      // an earlier payment of the same item before a second checkout is created.
      const before = await call({ action: "usage" });
      if (!before.ok) return before;
      const usage = before.value as BillingUsage;
      const admission = tracker.admit(intent, usage, input.repeatHold);
      if (admission.kind !== "proceed") return { ok: true, value: admission };
      const credits = intent.kind === "credits" ? await creditsOf(intent.packId) : 0;
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
      tracker.begin(intent, usage, credits);
      return { ok: true, value: { kind: "window" } };
    } finally {
      starting = false;
    }
  }

  async function billing(input: ApiInput): Promise<{ ok: true; value: unknown } | Failure> {
    deps.accountSignal.throwIfAborted();
    if (input.action === "checkPurchase") return { ok: true, value: { checking: tracker.checkAgain(input.item) } };
    if (input.action === "checkout" || input.action === "buyCreditPack") return startCheckout(input);
    return call(input);
  }

  return {
    billing,
    /** This account's purchase records, for the Plan tab. */
    purchases: () => tracker.records(),
    /** The checkout window closed for a reason other than the account session ending. */
    checkoutClosed: (outcome: CheckoutOutcome) => tracker.windowClosed(outcome),
  };
}

export type BillingApi = ReturnType<typeof createBillingApi>;
