import { z } from "zod";
import { SUPPORTED_LANGUAGES } from "../../../lib/language";
import { BILLING_CURRENCIES } from "../../../lib/billingMarkets";
import { linkViewUrl } from "./web-view-contract";

/**
 * Desktop's in-app plan and payment screens.
 *
 * The renderer names an action; the main process maps it to the web's own
 * billing route (the same request the web makes), sends it with the account
 * settings session, and parses the answer here. Desktop adds no billing rule of
 * its own: prices, eligibility, proration and promotion checks are the server's.
 */

const planId = z.enum(["pro", "max"]);
const billingInterval = z.enum(["monthly", "annual"]);
const changeTier = z.enum(["Pro", "Max"]);
const accountPlan = z.enum(["Free", "Pro", "Max"]);
const currency = z.enum(BILLING_CURRENCIES);
const language = z.enum(SUPPORTED_LANGUAGES);
const promoCode = z.string().trim().toUpperCase().min(2).max(32);
const packId = z.string().regex(/^[a-z0-9_]{1,32}$/);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const label = z.string().max(400);
const amount = z.number().finite();
const minor = z.number().int().nonnegative();
const timestamp = z.string().max(64);
// The token the main process issued with its warning about an unconfirmed payment of the same item.
// It is checked in the main process and never sent to the server.
const repeatHold = z.uuid().optional();

/** One thing the account can buy: its subscription (whatever the plan), or one credit pack. */
export type PurchaseItem = "subscription" | `credits:${string}`;
const PURCHASE_ITEM = /^(subscription|credits:[a-z0-9_]{1,32})$/;
const purchaseItemInput = z.custom<PurchaseItem>((value) => typeof value === "string" && PURCHASE_ITEM.test(value));

export const desktopBillingInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("usage") }).strict(),
  z.object({ action: z.literal("config") }).strict(),
  z.object({ action: z.literal("creditPacks") }).strict(),
  z.object({ action: z.literal("planChange") }).strict(),
  z.object({ action: z.literal("refundStatus") }).strict(),
  z.object({ action: z.literal("validatePromotion"), planId, billingInterval, promoCode, currency }).strict(),
  z.object({
    action: z.literal("checkout"), planId, billingInterval, promoCode: promoCode.optional(), currency, language,
    // One customer submission; the server turns it into the Stripe idempotency key.
    purchaseAttemptId: z.uuid(),
    repeatHold,
  }).strict(),
  z.object({ action: z.literal("buyCreditPack"), packId, currency, language, repeatHold }).strict(),
  z.object({ action: z.literal("previewPlanChange"), targetTier: changeTier, billingInterval }).strict(),
  // Only ever the customer's own tick of the separate renewal control.
  z.object({ action: z.literal("confirmPlanChange"), requestId, resumeRenewal: z.literal(true).optional() }).strict(),
  z.object({ action: z.literal("cancelPlanChange") }).strict(),
  z.object({ action: z.literal("cancelSubscription") }).strict(),
  z.object({ action: z.literal("requestRefund"), reason: z.string().trim().max(1_000) }).strict(),
  z.object({ action: z.literal("closeCheckout") }).strict(),
  // The purchase records the main process keeps for the account, and a renewed account check for one of them.
  z.object({ action: z.literal("purchases") }).strict(),
  z.object({ action: z.literal("checkPurchase"), item: purchaseItemInput }).strict(),
]);

export type DesktopBillingInput = z.infer<typeof desktopBillingInput>;
export type BillingAction = DesktopBillingInput["action"];
/** Actions the main process answers itself, without a billing route. */
export type BillingDesktopAction = "closeCheckout" | "purchases" | "checkPurchase";
export type BillingServerAction = Exclude<BillingAction, BillingDesktopAction>;

const promotion = z.object({
  discountPercent: amount,
  discountAmountCents: amount.nullable().optional(),
  durationMonths: z.number().int().nonnegative(),
  fulfillmentType: z.enum(["stripe_subscription", "internal_pass"]),
  accessDurationDays: z.number().int().positive().nullable(),
  paymentMethodRequired: z.boolean(),
  automaticRenewal: z.boolean(),
  allowAnnualStacking: z.boolean(),
});

const reservation = z.object({
  requestId,
  direction: z.enum(["upgrade", "downgrade"]),
  execution: z.enum(["immediate_upgrade", "scheduled_downgrade"]),
  fromTier: changeTier,
  toTier: changeTier,
  billingInterval,
  status: z.enum(["pending", "applied", "cancelled", "expired", "failed"]),
  appliesAt: timestamp.nullable(),
  cancellable: z.boolean(),
});

const quote = z.object({
  requestId,
  direction: z.enum(["upgrade", "downgrade"]),
  execution: z.enum(["immediate_upgrade", "scheduled_downgrade"]),
  fromTier: changeTier,
  toTier: changeTier,
  billingInterval,
  currency: z.string().max(8),
  amountDueMinor: z.number().int().nullable(),
  credits: z.object({ monthlyPlanCredits: amount, remainingPlanCredits: amount, overageCredits: amount }).nullable(),
  effectiveAt: timestamp.nullable(),
  renewal: z.enum(["unaffected", "cancellation_preserved", "cancellation_cleared_by_explicit_consent"]),
  expiresAt: timestamp,
});

/** Server responses, keyed by action. Unknown fields are dropped. */
export const desktopBillingResponse = {
  usage: z.object({
    plan: accountPlan,
    subscription: z.object({
      status: z.string().max(64).nullable(),
      billingInterval: billingInterval.nullable().catch(null),
      currentPeriodEnd: timestamp.nullable(),
      cancelAtPeriodEnd: z.boolean(),
    }),
    balances: z.object({
      dailyRemainingCredits: amount.nullable(),
      dailyResetsAt: timestamp,
      planRemainingCredits: amount,
      planResetsAt: timestamp,
      purchasedRemainingCredits: amount,
      purchasedEarliestExpiry: timestamp.nullable(),
    }),
  }),
  config: z.object({
    plans: z.array(z.object({
      id: z.enum(["free", "pro", "max"]),
      name: label,
      monthlyMessageLimit: amount,
      displayCurrency: currency,
      displayMonthlyPriceMinor: minor,
      displayAnnualPriceMinor: minor,
    })).max(10),
    featuredPromotion: z.object({
      code: promoCode,
      appliesToPlanIds: z.array(z.enum(["free", "pro", "max"])).max(3),
      billingIntervals: z.array(billingInterval).max(2),
    }).nullable().catch(null),
    displayCountry: z.string().regex(/^[A-Z]{2}$/),
  }),
  creditPacks: z.object({
    plan: accountPlan,
    packs: z.array(z.object({ id: packId, name: label, credits: amount, priceMinor: minor, currency, validityDays: amount })).max(20),
  }),
  planChange: z.object({ reservation: reservation.nullable() }),
  refundStatus: z.object({
    pendingRequest: z.object({ id: requestId, status: z.string().max(32), requestedAt: timestamp }).nullable(),
  }),
  validatePromotion: z.object({ valid: z.literal(true), promotion }),
  // A Stripe Checkout Session, or a complimentary pass the server activated without one.
  checkout: z.union([
    z.object({ url: z.string().max(8_192) }),
    z.object({ success: z.literal(true), accessType: z.literal("founding_tester_pass"), periodEnd: timestamp }),
  ]),
  buyCreditPack: z.object({ url: z.string().max(8_192) }),
  previewPlanChange: z.object({ quote }),
  confirmPlanChange: z.object({ reservation }),
  cancelPlanChange: z.object({ success: z.literal(true) }),
  cancelSubscription: z.object({ cancelAtPeriodEnd: z.literal(true), currentPeriodEnd: timestamp.nullable() }),
  requestRefund: z.object({ requestId, requestedAt: timestamp }),
} satisfies Record<BillingServerAction, z.ZodType>;

type ServerValue<Action extends BillingServerAction> = z.infer<(typeof desktopBillingResponse)[Action]>;

/**
 * A checkout the main process did not start: "held" when the account still does not show an earlier
 * payment of the same item (the customer is warned; only a request carrying `hold` goes ahead),
 * "settled" when the fresh read showed that earlier payment after all.
 */
export type PurchaseHeldBack = { kind: "held"; hold: string } | { kind: "settled" };

/** What the renderer receives. Checkout never hands the Stripe URL back to the renderer. */
export type BillingValue<Action extends BillingAction> =
  Action extends "checkout" ? { kind: "window" } | { kind: "pass"; periodEnd: string } | PurchaseHeldBack
    : Action extends "buyCreditPack" ? { kind: "window" } | PurchaseHeldBack
      : Action extends "closeCheckout" ? { closed: boolean }
        : Action extends "purchases" ? BillingState
          : Action extends "checkPurchase" ? { checking: boolean }
            : Action extends BillingServerAction ? ServerValue<Action> : never;

/** Codes Desktop reports itself, beside the server's own `code` values. */
export const DESKTOP_BILLING_CODES = ["NETWORK_ERROR", "INVALID_RESPONSE", "CHECKOUT_URL_REJECTED", "CHECKOUT_WINDOW_OPEN"] as const;

export type BillingResult<Action extends BillingAction> =
  | { ok: true; value: BillingValue<Action> }
  | { ok: false; status: number; code: string | null };

export type BillingUsage = ServerValue<"usage">;
export type BillingConfig = ServerValue<"config">;
export type BillingCreditPacks = ServerValue<"creditPacks">;
export type BillingPromotion = z.infer<typeof promotion>;
export type PlanChangeQuote = z.infer<typeof quote>;
export type PlanChangeReservation = z.infer<typeof reservation>;

/** A stable server error code, or null. Server error text is never passed on. */
export function billingErrorCode(body: unknown): string | null {
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
}

export const STRIPE_CHECKOUT_HOST = "checkout.stripe.com";

/**
 * The one deterministic check on a Checkout URL before the app opens it: https on
 * Stripe's Checkout host, no credentials, no port. Anything else is refused.
 */
export function stripeCheckoutUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 8_192) return null;
  let target: URL;
  try { target = new URL(value); } catch { return null; }
  if (target.protocol !== "https:" || target.username || target.password || target.port) return null;
  return target.hostname === STRIPE_CHECKOUT_HOST ? target : null;
}

/** Tomverse's own pages: the configured origins, or any https tomverse.app host. */
export function isTomverseUrl(value: string, origins: readonly string[]): boolean {
  let target: URL;
  try { target = new URL(value); } catch { return false; }
  if (target.username || target.password) return false;
  if (origins.includes(target.origin)) return true;
  const host = target.hostname.toLowerCase();
  return target.protocol === "https:" && (host === "tomverse.app" || host.endsWith(".tomverse.app"));
}

export type CheckoutNavigation = "allow" | "return" | "block";

/**
 * Where the checkout window may go. Stripe and the card issuer's 3-D Secure pages
 * are public https hosts and stay in the window; a Tomverse page is the server's
 * success or cancel URL, so the window closes instead of loading it.
 */
export function classifyCheckoutNavigation(value: string, origins: readonly string[]): CheckoutNavigation {
  if (isTomverseUrl(value, origins)) return "return";
  return linkViewUrl(value) ? "allow" : "block";
}

export type CheckoutReturn = "success" | "cancelled" | "returned";
export type CheckoutOutcome = CheckoutReturn | "closed";
export type CheckoutPurpose = "subscription" | "credits";

/**
 * What the return URL says happened. Whether a payment went through is decided from the
 * account the server reports afterwards, in either direction: a cancel page does not shorten
 * or end the account check. A cancel page has one effect besides the wording: that attempt
 * does not hold a new checkout of the same item back.
 */
export function checkoutReturnOutcome(value: string): CheckoutReturn {
  let target: URL;
  try { target = new URL(value); } catch { return "returned"; }
  const billing = target.searchParams.get("billing");
  if (billing === "success" || billing === "credits-success") return "success";
  if (billing === "cancelled" || billing === "credits-cancelled") return "cancelled";
  return "returned";
}

export type BillingWindowState =
  | { stage: "open"; purpose: CheckoutPurpose; host: string; loading: boolean; failed: boolean }
  | { stage: "closed"; purpose: CheckoutPurpose; outcome: CheckoutOutcome };

export type PurchaseIntent = { kind: "subscription"; planId: "pro" | "max" } | { kind: "credits"; packId: string };

/**
 * The record a purchase is tracked under. An account holds one subscription, so every plan
 * shares one record and any subscription checkout repeats an unconfirmed one; each credit
 * pack has its own.
 */
export const purchaseItem = (intent: PurchaseIntent): PurchaseItem =>
  intent.kind === "subscription" ? "subscription" : `credits:${intent.packId}`;

/**
 * A purchase the main process tracks for the connected account: "open" while its checkout
 * window is, "checking" while the account is read after it, then "confirmed" when the account
 * shows it or "unconfirmed" when the reads did not (never "unpaid"). `cancelled`: the window
 * came back on the cancel page, which sets the wording only.
 */
export type PurchaseStage = "open" | "checking" | "unconfirmed" | "confirmed";
export type PurchaseRecord = {
  id: string; item: PurchaseItem; intent: PurchaseIntent; stage: PurchaseStage; cancelled: boolean; startedAt: number;
};

/** What the main process publishes to the Plan tab, and answers when a screen asks on mount. */
export type BillingState = {
  /** Increases with every change; a screen keeps the highest it has seen. */
  version: number;
  window: Extract<BillingWindowState, { stage: "open" }> | null;
  purchases: PurchaseRecord[];
};

/**
 * True only when the account the server reports shows the purchase: the plan moved
 * to the one bought, or the purchased-credit balance grew.
 */
export function purchaseConfirmed(
  intent: PurchaseIntent,
  before: Pick<BillingUsage, "plan" | "balances">,
  after: Pick<BillingUsage, "plan" | "balances">,
): boolean {
  if (intent.kind === "subscription") {
    const tier = intent.planId === "max" ? "Max" : "Pro";
    return after.plan === tier && before.plan !== tier;
  }
  return after.balances.purchasedRemainingCredits > before.balances.purchasedRemainingCredits;
}
