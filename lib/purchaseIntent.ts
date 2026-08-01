/**
 * One contract for "what was this visitor trying to buy, and where should they
 * end up afterwards".
 *
 * The pricing page, the sign-in round trip, the credit-pack modal and the
 * Stripe checkout route all need the same four facts -- purchase type, target
 * product, where the click came from, and where to return -- and before this
 * module each of them invented its own encoding, or dropped the facts
 * entirely. `/pricing` rendered a "Sign in to buy credits" link to `/chat`
 * for everyone, so a signed-in visitor was sent to the chat welcome screen
 * instead of a purchase, and a signed-out one arrived at `/chat` having lost
 * the pack they picked.
 *
 * Everything here is pure and has no DOM or Node dependency, so the browser,
 * the route handler and the unit tests all read the same rules.
 */

export const PURCHASE_INTENTS = ["subscription", "credit_pack"] as const;
export type PurchaseIntentType = (typeof PURCHASE_INTENTS)[number];

export const PURCHASE_TARGET_PLANS = ["pro", "max"] as const;
export type PurchaseTargetPlan = (typeof PURCHASE_TARGET_PLANS)[number];

export const PURCHASE_CREDIT_PACK_IDS = [
  "starter_500",
  "project_1500",
  "power_4000",
] as const;
export type PurchaseCreditPackId = (typeof PURCHASE_CREDIT_PACK_IDS)[number];

export const PRICING_PLANS_ANCHOR = "plans";
export const PRICING_CREDIT_PACKS_ANCHOR = "credit-packs";

/** Anchors a `returnTo` is allowed to carry back through Stripe. */
const ALLOWED_RETURN_HASHES = new Set([
  PRICING_PLANS_ANCHOR,
  PRICING_CREDIT_PACKS_ANCHOR,
]);

const PURCHASE_TRIGGERS = [
  "limit_hit",
  "usage_widget",
  "account",
  "proactive",
] as const;

const APP_LANGUAGES = [
  "en",
  "ko",
  "zh",
  "fr",
  "de",
  "es",
  "pt",
] as const;
export type PurchaseIntentLanguage = (typeof APP_LANGUAGES)[number];

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;

/**
 * Paths a purchase round trip may return to.
 *
 * Deliberately short. Every entry has to be a page that can render a billing
 * outcome, and adding one means deciding what it shows on success and on
 * cancel -- not just that it exists.
 */
const RETURN_TO_PATHS = new Set(["/pricing", "/chat"]);

/**
 * Query keys a `returnTo` may carry. Anything else is dropped rather than
 * rejected: a stale `?promo=` on the page the visitor happened to be on is not
 * a reason to lose their purchase, but it is also not something to hand to
 * Stripe and reflect back into the app.
 */
const RETURN_TO_QUERY_KEYS = new Set<string>([
  "lang",
  "trigger",
  "ctaLocation",
  "intent",
  "target",
  "pack",
  ...UTM_KEYS,
]);

/** Values that must never be echoed back as campaign attribution. */
const isCampaignValue = (value: string | null | undefined) =>
  Boolean(value && !value.startsWith("(") && value.length <= 100);

const oneOf = <T extends string>(
  allowed: readonly T[],
  value: unknown
): T | null =>
  typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;

export const normalizePurchaseIntentType = (value: unknown) =>
  oneOf(PURCHASE_INTENTS, value);
export const normalizePurchaseTargetPlan = (value: unknown) =>
  oneOf(PURCHASE_TARGET_PLANS, value);
export const normalizeCreditPackId = (value: unknown) =>
  oneOf(PURCHASE_CREDIT_PACK_IDS, value);
export const normalizePurchaseLanguage = (value: unknown) =>
  oneOf(APP_LANGUAGES, value);
const normalizeTrigger = (value: unknown) => oneOf(PURCHASE_TRIGGERS, value);

/**
 * A CTA's own identity, used for analytics and for deciding which pack a
 * resumed purchase should preselect. Constrained to the same shape the
 * analytics schema accepts so a hand-written value can never be silently
 * dropped at send time.
 */
export const normalizeCtaLocation = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;
  return /^[a-z0-9_]+$/.test(trimmed) ? trimmed : null;
};

export type PurchaseIntent = {
  intent: PurchaseIntentType | null;
  targetPlan: PurchaseTargetPlan | null;
  packId: PurchaseCreditPackId | null;
  trigger: (typeof PURCHASE_TRIGGERS)[number] | null;
  ctaLocation: string | null;
  lang: PurchaseIntentLanguage | null;
  utm: Partial<Record<(typeof UTM_KEYS)[number], string>>;
};

const emptyIntent = (): PurchaseIntent => ({
  intent: null,
  targetPlan: null,
  packId: null,
  trigger: null,
  ctaLocation: null,
  lang: null,
  utm: {},
});

/**
 * Reads a purchase intent out of a query string.
 *
 * Accepts either a raw `?a=b` string or a `URLSearchParams`, because the
 * pricing page reads `window.location.search` (it is a `force-static` route,
 * so `useSearchParams` would opt the whole tree out of prerendering) while the
 * tests hand in params directly.
 */
export function parsePurchaseIntent(
  source: string | URLSearchParams | null | undefined
): PurchaseIntent {
  if (!source) return emptyIntent();
  let params: URLSearchParams;
  try {
    params =
      typeof source === "string" ? new URLSearchParams(source) : source;
  } catch {
    return emptyIntent();
  }
  const utm: PurchaseIntent["utm"] = {};
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (isCampaignValue(value)) utm[key] = value!;
  }
  return {
    intent: normalizePurchaseIntentType(params.get("intent")),
    targetPlan: normalizePurchaseTargetPlan(params.get("target")),
    packId: normalizeCreditPackId(params.get("pack")),
    trigger: normalizeTrigger(params.get("trigger")),
    ctaLocation: normalizeCtaLocation(params.get("ctaLocation")),
    lang: normalizePurchaseLanguage(params.get("lang")),
    utm,
  };
}

/**
 * Builds a `/pricing` URL that carries the visitor's purchase intent.
 *
 * The anchor matters as much as the query: a visitor who clicked "Upgrade" in
 * the sidebar has to land on the plan they asked for, not at the top of a page
 * whose first screen is a headline.
 */
export function buildPricingIntentHref({
  lang,
  intent,
  targetPlan,
  packId,
  trigger,
  ctaLocation,
  utm,
  anchor,
}: {
  lang: string;
  intent?: PurchaseIntentType | null;
  targetPlan?: PurchaseTargetPlan | null;
  packId?: PurchaseCreditPackId | null;
  trigger?: string | null;
  ctaLocation?: string | null;
  utm?: Partial<Record<(typeof UTM_KEYS)[number], string | null | undefined>>;
  anchor?: string | null;
}): string {
  const params = new URLSearchParams();
  const language = normalizePurchaseLanguage(lang);
  if (language) params.set("lang", language);
  const normalizedIntent = normalizePurchaseIntentType(intent);
  if (normalizedIntent) params.set("intent", normalizedIntent);
  const normalizedTarget = normalizePurchaseTargetPlan(targetPlan);
  if (normalizedTarget) params.set("target", normalizedTarget);
  const normalizedPack = normalizeCreditPackId(packId);
  if (normalizedPack) params.set("pack", normalizedPack);
  const normalizedTrigger = normalizeTrigger(trigger);
  if (normalizedTrigger) params.set("trigger", normalizedTrigger);
  const normalizedCtaLocation = normalizeCtaLocation(ctaLocation);
  if (normalizedCtaLocation) params.set("ctaLocation", normalizedCtaLocation);
  for (const key of UTM_KEYS) {
    const value = utm?.[key];
    if (isCampaignValue(value)) params.set(key, value!);
  }
  const query = params.toString();
  const hash = anchor && ALLOWED_RETURN_HASHES.has(anchor) ? `#${anchor}` : "";
  return `/pricing${query ? `?${query}` : ""}${hash}`;
}

/**
 * Reduces an arbitrary client-supplied string to a same-origin relative path
 * this product is willing to send someone back to.
 *
 * Returns `null` for anything it does not fully recognise. Callers substitute
 * their own default rather than passing the original value through, so an
 * attacker-controlled string never reaches Stripe's `success_url`.
 */
export function sanitizeReturnTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 512) return null;
  // A relative path is the only accepted shape. This rejects `https://evil`,
  // `//evil.com`, `/\evil.com` (which several browsers treat as protocol
  // relative), and any `javascript:`/`data:` scheme before parsing.
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // Control characters and whitespace are how an encoded scheme sneaks past a
  // prefix check ("/\t/evil.com", "/%0a//evil.com").
  if (/[\u0000-\u0020\u007f]/.test(raw)) return null;
  if (/%2f%2f|%5c|%09|%0a|%0d/i.test(raw)) return null;

  const base = "https://return-to.invalid";
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    return null;
  }
  if (parsed.origin !== base) return null;

  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (!RETURN_TO_PATHS.has(pathname)) return null;

  const params = new URLSearchParams();
  for (const [key, entry] of parsed.searchParams) {
    if (!RETURN_TO_QUERY_KEYS.has(key)) continue;
    if (entry.length > 100) continue;
    params.set(key, entry);
  }
  const query = params.toString();

  const hash = parsed.hash.replace(/^#/, "");
  const safeHash = ALLOWED_RETURN_HASHES.has(hash) ? `#${hash}` : "";

  return `${pathname}${query ? `?${query}` : ""}${safeHash}`;
}

export type CreditPackReturnUrls = {
  successUrl: string;
  cancelUrl: string;
  /** The relative path the URLs were built from, for logging and tests. */
  returnPath: string;
};

/**
 * Decides where a credit-pack checkout returns to, on the server.
 *
 * The client only ever *proposes* a return path; this function is what turns
 * it into an absolute URL, and it substitutes the default the moment the
 * proposal fails validation. Both outcomes carry the pack id so the page they
 * land on can name what was bought (or restore what was abandoned) rather than
 * showing a bare "payment cancelled".
 */
export function buildCreditPackReturnUrls({
  origin,
  returnTo,
  packId,
  language,
}: {
  origin: string;
  returnTo?: unknown;
  packId: string;
  language?: string | null;
}): CreditPackReturnUrls {
  const returnPath = sanitizeReturnTo(returnTo) || "/chat";
  const [pathAndQuery, hash] = returnPath.split("#");
  const [pathname, query] = (pathAndQuery || "/chat").split("?");

  const build = (billing: "credits-success" | "credits-cancelled") => {
    const params = new URLSearchParams(query || "");
    // The purchase intent has been fulfilled or abandoned by this point:
    // leaving it in the URL would re-open the pack picker on arrival.
    params.delete("intent");
    params.delete("target");
    params.set("billing", billing);
    params.set("pack", packId);
    const normalizedLanguage = normalizePurchaseLanguage(language);
    if (normalizedLanguage) params.set("lang", normalizedLanguage);
    return `${origin}${pathname}?${params.toString()}${hash ? `#${hash}` : ""}`;
  };

  return {
    successUrl: build("credits-success"),
    cancelUrl: build("credits-cancelled"),
    returnPath,
  };
}

/**
 * Builds the sign-in URL that preserves a purchase intent across the login
 * round trip. The callback is sanitized with the same rules Stripe returns
 * go through, so a caller cannot smuggle an off-site destination in either.
 */
export function buildPurchaseSignInHref(callbackUrl: string): string {
  const safeCallback = sanitizeReturnTo(callbackUrl) || "/pricing";
  return `/auth/signin?callbackUrl=${encodeURIComponent(safeCallback)}`;
}

export const BILLING_ERROR_CODES = [
  "AUTHENTICATION_REQUIRED",
  "SESSION_EXPIRED",
  "PACK_NOT_AVAILABLE_FOR_PLAN",
  "CHECKOUT_CONFIGURATION_ERROR",
  "BILLING_MARKET_MISMATCH",
  "ACTIVE_SUBSCRIPTION_EXISTS",
  "PLAN_CHANGE_NOT_SUPPORTED",
  "CHECKOUT_RATE_LIMITED",
  "NETWORK_ERROR",
  "UNKNOWN_ERROR",
] as const;

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

/**
 * Turns a billing response into one of the failures this product has copy for.
 *
 * `wasAuthenticated` is what separates "you were never signed in" from "your
 * session expired mid-purchase": both are a 401 on the wire, but only the
 * second one should tell someone their work is still waiting for them.
 */
export function classifyBillingError({
  status,
  code,
  wasAuthenticated = false,
  networkFailure = false,
}: {
  status?: number | null;
  code?: unknown;
  wasAuthenticated?: boolean;
  networkFailure?: boolean;
}): BillingErrorCode {
  if (networkFailure) return "NETWORK_ERROR";
  // A 401 is classified by who was asking, not by the code the server chose.
  // Every endpoint answers an unauthenticated request with the same generic
  // AUTHENTICATION_REQUIRED, but the caller knows whether there *was* a
  // session -- and "sign in to buy credits" is the wrong thing to tell someone
  // whose session lapsed halfway through a purchase they had already started.
  if (status === 401) {
    return wasAuthenticated ? "SESSION_EXPIRED" : "AUTHENTICATION_REQUIRED";
  }
  if (typeof code === "string") {
    const known = BILLING_ERROR_CODES.find((entry) => entry === code);
    if (known) return known;
    if (code === "API_RATE_LIMITED") return "CHECKOUT_RATE_LIMITED";
  }
  if (status === 403) return "PACK_NOT_AVAILABLE_FOR_PLAN";
  if (status === 409) return "ACTIVE_SUBSCRIPTION_EXISTS";
  if (status === 429) return "CHECKOUT_RATE_LIMITED";
  if (status === 503) return "CHECKOUT_CONFIGURATION_ERROR";
  return "UNKNOWN_ERROR";
}

/** Failures the visitor can act on themselves by trying again. */
const RETRYABLE_BILLING_ERRORS = new Set<BillingErrorCode>([
  "NETWORK_ERROR",
  "CHECKOUT_RATE_LIMITED",
  "UNKNOWN_ERROR",
]);

/** Failures whose next step is signing in again, not retrying. */
const REAUTHENTICATION_BILLING_ERRORS = new Set<BillingErrorCode>([
  "AUTHENTICATION_REQUIRED",
  "SESSION_EXPIRED",
]);

export const isRetryableBillingError = (code: BillingErrorCode) =>
  RETRYABLE_BILLING_ERRORS.has(code);

export const requiresReauthentication = (code: BillingErrorCode) =>
  REAUTHENTICATION_BILLING_ERRORS.has(code);

/**
 * Failures the visitor resolves inside the dialog they are already in --
 * picking a different pack, in practice. Offering "contact support" for one of
 * these would send someone away from the fix that is on screen in front of
 * them.
 */
const SELF_RESOLVABLE_BILLING_ERRORS = new Set<BillingErrorCode>([
  "PACK_NOT_AVAILABLE_FOR_PLAN",
]);

export const isSelfResolvableBillingError = (code: BillingErrorCode) =>
  SELF_RESOLVABLE_BILLING_ERRORS.has(code);

/** Failures a visitor cannot resolve alone, so the copy has to offer support. */
export const requiresSupport = (code: BillingErrorCode) =>
  !isRetryableBillingError(code) &&
  !requiresReauthentication(code) &&
  !isSelfResolvableBillingError(code);

/**
 * Support-form topic the plan-change CTA opens on.
 *
 * Mirrors the `billing` key in SupportPageContent's `types` map. Plan changes
 * are handled as a written support request until the flow in
 * docs/policy/plan-change.md is built, so this is the CTA's real destination --
 * not a placeholder for one.
 */
export const PLAN_CHANGE_SUPPORT_TOPIC = "billing";

/**
 * Where a visitor goes when they want a plan change this product cannot yet
 * perform online.
 *
 * The CTA used to point at `/chat` with "handled in account settings", which
 * was not true: account settings can cancel a subscription, not change one.
 * Sending someone to a screen that cannot do the thing is the same dead end as
 * a checkout that answers 409, just slower to discover.
 */
export function buildPlanChangeSupportHref(lang: string): string {
  const params = new URLSearchParams();
  params.set("topic", PLAN_CHANGE_SUPPORT_TOPIC);
  const language = normalizePurchaseLanguage(lang);
  if (language) params.set("lang", language);
  return `/support?${params.toString()}`;
}

export type AccountPlanTier = "Free" | "Pro" | "Max";
export type PricingPlanCtaState =
  | "loading"
  | "signed_out"
  | "current_plan"
  | "upgrade"
  | "manage_plan";

const PLAN_RANK: Record<AccountPlanTier, number> = { Free: 0, Pro: 1, Max: 2 };

/**
 * The single decision behind every plan CTA on the pricing page.
 *
 * It is deliberately state-driven rather than plan-name-driven: "Pro sees an
 * Upgrade button on the Max card" is one rule here, not three conditionals
 * spread across a card renderer, and the downgrade case cannot silently fall
 * through to "Upgrade" the way it used to.
 *
 * `Max` looking at `Pro` resolves to `manage_plan`, never `upgrade`: this
 * product has no in-app subscription-change flow (only cancel-at-period-end),
 * so a checkout started there would be rejected with a 409 after the visitor
 * had already committed.
 */
export function resolvePlanCtaState({
  sessionStatus,
  currentPlan,
  cardPlan,
  hasActiveSubscription,
}: {
  sessionStatus: "loading" | "authenticated" | "unauthenticated";
  currentPlan: AccountPlanTier | null;
  cardPlan: AccountPlanTier;
  hasActiveSubscription: boolean;
}): PricingPlanCtaState {
  if (sessionStatus === "loading") return "loading";
  if (sessionStatus === "unauthenticated") return "signed_out";
  // Authenticated but the authoritative plan has not arrived yet. Guessing
  // here is what produced a dead "Upgrade to Pro" button for Pro subscribers.
  if (!currentPlan) return "loading";
  if (currentPlan === cardPlan) return "current_plan";
  if (PLAN_RANK[cardPlan] > PLAN_RANK[currentPlan]) {
    // Free -> Pro/Max is a fresh subscription. Pro -> Max is a change to an
    // existing Stripe subscription, which /api/billing/checkout refuses.
    return hasActiveSubscription ? "manage_plan" : "upgrade";
  }
  return "manage_plan";
}

/** True when the Free card should not offer a sign-up CTA at all. */
export const shouldHideFreePlanCta = (
  sessionStatus: "loading" | "authenticated" | "unauthenticated",
  currentPlan: AccountPlanTier | null
) =>
  sessionStatus === "authenticated" &&
  (currentPlan === "Pro" || currentPlan === "Max");
