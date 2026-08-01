import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCreditPackReturnUrls,
  buildPlanChangeSupportHref,
  buildPricingIntentHref,
  buildPurchaseSignInHref,
  classifyBillingError,
  isRetryableBillingError,
  parsePurchaseIntent,
  requiresReauthentication,
  requiresSupport,
  resolvePlanCtaState,
  sanitizeReturnTo,
  shouldHideFreePlanCta,
} from "../lib/purchaseIntent.ts";

test("a pricing href carries the whole purchase intent, including the plan anchor", () => {
  assert.equal(
    buildPricingIntentHref({
      lang: "ko",
      intent: "subscription",
      targetPlan: "pro",
      trigger: "account",
      anchor: "plans",
    }),
    "/pricing?lang=ko&intent=subscription&target=pro&trigger=account#plans"
  );
});

test("a credit-pack href keeps the pack the visitor actually clicked", () => {
  const href = buildPricingIntentHref({
    lang: "en",
    intent: "credit_pack",
    packId: "project_1500",
    ctaLocation: "pricing_credit_pack_card",
    anchor: "credit-packs",
    utm: { utm_source: "qa", utm_medium: "e2e", utm_campaign: "(not set)" },
  });

  const url = new URL(href, "https://tomverse.app");
  assert.equal(url.searchParams.get("intent"), "credit_pack");
  assert.equal(url.searchParams.get("pack"), "project_1500");
  assert.equal(url.searchParams.get("ctaLocation"), "pricing_credit_pack_card");
  assert.equal(url.searchParams.get("utm_source"), "qa");
  // "(not set)" is the placeholder the analytics client stores when there was
  // no campaign at all, and echoing it into a URL would invent attribution.
  assert.equal(url.searchParams.get("utm_campaign"), null);
  assert.equal(url.hash, "#credit-packs");
});

test("an unrecognised plan, pack, or anchor is dropped rather than echoed", () => {
  assert.equal(
    buildPricingIntentHref({
      lang: "xx",
      intent: "gift_card",
      targetPlan: "enterprise",
      packId: "unlimited_9999",
      anchor: "faq",
    }),
    "/pricing"
  );
});

test("a purchase intent survives a round trip through the query string", () => {
  const href = buildPricingIntentHref({
    lang: "ko",
    intent: "credit_pack",
    packId: "starter_500",
    trigger: "usage_widget",
    ctaLocation: "pricing_credit_pack_section",
    anchor: "credit-packs",
  });
  const intent = parsePurchaseIntent(new URL(href, "https://x.test").search);

  assert.deepEqual(intent, {
    intent: "credit_pack",
    targetPlan: null,
    packId: "starter_500",
    trigger: "usage_widget",
    ctaLocation: "pricing_credit_pack_section",
    lang: "ko",
    utm: {},
  });
});

test("a hand-edited intent query cannot smuggle unknown values through", () => {
  const intent = parsePurchaseIntent(
    "?intent=wire_transfer&target=enterprise&pack=../../etc/passwd&trigger=<script>&lang=xx&ctaLocation=DROP TABLE"
  );

  assert.equal(intent.intent, null);
  assert.equal(intent.targetPlan, null);
  assert.equal(intent.packId, null);
  assert.equal(intent.trigger, null);
  assert.equal(intent.lang, null);
  assert.equal(intent.ctaLocation, null);
});

test("returnTo accepts only the same-origin routes that can show a billing outcome", () => {
  assert.equal(sanitizeReturnTo("/pricing"), "/pricing");
  assert.equal(sanitizeReturnTo("/chat"), "/chat");
  assert.equal(
    sanitizeReturnTo("/pricing?lang=ko#credit-packs"),
    "/pricing?lang=ko#credit-packs"
  );
  // Trailing slashes normalise rather than fail: the router treats them as the
  // same route, so rejecting one would drop a purchase for a cosmetic reason.
  assert.equal(sanitizeReturnTo("/chat/"), "/chat");
  // A real page that simply is not part of a purchase round trip.
  assert.equal(sanitizeReturnTo("/admin/overview"), null);
  assert.equal(sanitizeReturnTo("/models"), null);
});

test("returnTo blocks every open-redirect shape", () => {
  for (const attack of [
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "https://evil.com/pricing",
    "http://evil.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//evil.com/pricing",
    "/pricing/../../evil",
    "/%2f%2fevil.com",
    "/\t/evil.com",
    "/\n//evil.com",
    "",
    null,
    undefined,
    42,
    { toString: () => "/pricing" },
  ]) {
    assert.equal(
      sanitizeReturnTo(attack),
      null,
      `expected ${JSON.stringify(String(attack))} to be rejected`
    );
  }
});

test("surrounding whitespace is trimmed, whitespace inside the path is not", () => {
  // Trimming the ends is safe -- the result still has to start with "/" and
  // still has to be an allowlisted route. Whitespace *inside* the string is
  // what lets a URL parser see a different string than the guard checked.
  assert.equal(sanitizeReturnTo("  /pricing  "), "/pricing");
  assert.equal(sanitizeReturnTo("/pric ing"), null);
});

test("returnTo keeps only the query keys a purchase round trip needs", () => {
  assert.equal(
    sanitizeReturnTo("/chat?lang=ko&conversation=secret&token=abc&utm_source=qa"),
    "/chat?lang=ko&utm_source=qa"
  );
});

test("returnTo keeps only anchors the pricing page actually has", () => {
  assert.equal(sanitizeReturnTo("/pricing#plans"), "/pricing#plans");
  assert.equal(sanitizeReturnTo("/pricing#credit-packs"), "/pricing#credit-packs");
  assert.equal(sanitizeReturnTo("/pricing#anything-else"), "/pricing");
});

test("checkout returns land back where the purchase started, with the pack named", () => {
  const urls = buildCreditPackReturnUrls({
    origin: "https://tomverse.app",
    returnTo: "/pricing?lang=ko&intent=credit_pack&pack=project_1500#credit-packs",
    packId: "project_1500",
    language: "ko",
  });

  assert.equal(
    urls.successUrl,
    "https://tomverse.app/pricing?lang=ko&pack=project_1500&billing=credits-success#credit-packs"
  );
  assert.equal(
    urls.cancelUrl,
    "https://tomverse.app/pricing?lang=ko&pack=project_1500&billing=credits-cancelled#credit-packs"
  );
});

test("a rejected returnTo falls back to /chat instead of being passed to Stripe", () => {
  const urls = buildCreditPackReturnUrls({
    origin: "https://tomverse.app",
    returnTo: "https://evil.com/steal",
    packId: "starter_500",
    language: "en",
  });

  assert.equal(urls.returnPath, "/chat");
  assert.equal(new URL(urls.successUrl).origin, "https://tomverse.app");
  assert.equal(new URL(urls.cancelUrl).origin, "https://tomverse.app");
  assert.match(urls.successUrl, /^https:\/\/tomverse\.app\/chat\?/);
});

test("a fulfilled purchase does not return with its intent still armed", () => {
  const urls = buildCreditPackReturnUrls({
    origin: "https://tomverse.app",
    returnTo: "/pricing?intent=credit_pack&target=pro&lang=en#credit-packs",
    packId: "power_4000",
  });

  const success = new URL(urls.successUrl);
  assert.equal(success.searchParams.get("intent"), null);
  assert.equal(success.searchParams.get("target"), null);
  assert.equal(success.searchParams.get("billing"), "credits-success");
});

test("the sign-in callback is sanitised with the same rules as a Stripe return", () => {
  assert.equal(
    buildPurchaseSignInHref("/pricing?lang=ko&intent=credit_pack#credit-packs"),
    `/auth/signin?callbackUrl=${encodeURIComponent(
      "/pricing?lang=ko&intent=credit_pack#credit-packs"
    )}`
  );
  assert.equal(
    buildPurchaseSignInHref("//evil.com"),
    `/auth/signin?callbackUrl=${encodeURIComponent("/pricing")}`
  );
});

test("a plan change nobody can do online lands on the support form, categorised", () => {
  // The CTA used to point at /chat "handled in account settings". Account
  // settings can cancel a subscription, not change one, so that was a dead end
  // dressed as a destination. Support genuinely does handle plan changes today
  // (see docs/policy/plan-change.md), and arriving with the category already
  // set is what makes it a handoff rather than a generic contact page.
  assert.equal(
    buildPlanChangeSupportHref("ko"),
    "/support?topic=billing&lang=ko"
  );
  // An unknown language is dropped rather than echoed into the URL.
  assert.equal(buildPlanChangeSupportHref("xx"), "/support?topic=billing");
});

test("a 401 is only a session expiry when there was a session to expire", () => {
  assert.equal(
    classifyBillingError({ status: 401, wasAuthenticated: true }),
    "SESSION_EXPIRED"
  );
  // The server answers every unauthenticated request with the same generic
  // code, so the caller's knowledge has to win -- otherwise someone whose
  // session lapsed mid-purchase is told to "sign in to buy credits" as though
  // they had never started.
  assert.equal(
    classifyBillingError({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      wasAuthenticated: true,
    }),
    "SESSION_EXPIRED"
  );
  assert.equal(
    classifyBillingError({ status: 401, wasAuthenticated: false }),
    "AUTHENTICATION_REQUIRED"
  );
});

test("billing failures map to the codes the UI has copy for", () => {
  assert.equal(classifyBillingError({ networkFailure: true }), "NETWORK_ERROR");
  assert.equal(
    classifyBillingError({ status: 429, code: "API_RATE_LIMITED" }),
    "CHECKOUT_RATE_LIMITED"
  );
  assert.equal(classifyBillingError({ status: 403 }), "PACK_NOT_AVAILABLE_FOR_PLAN");
  assert.equal(classifyBillingError({ status: 409 }), "ACTIVE_SUBSCRIPTION_EXISTS");
  assert.equal(classifyBillingError({ status: 503 }), "CHECKOUT_CONFIGURATION_ERROR");
  assert.equal(
    classifyBillingError({ status: 400, code: "BILLING_MARKET_MISMATCH" }),
    "BILLING_MARKET_MISMATCH"
  );
  assert.equal(classifyBillingError({ status: 500 }), "UNKNOWN_ERROR");
});

test("every failure is either retryable, re-authenticable, or a support case", () => {
  assert.equal(isRetryableBillingError("NETWORK_ERROR"), true);
  assert.equal(requiresReauthentication("SESSION_EXPIRED"), true);
  assert.equal(requiresSupport("CHECKOUT_CONFIGURATION_ERROR"), true);
  assert.equal(requiresSupport("NETWORK_ERROR"), false);
  assert.equal(requiresSupport("SESSION_EXPIRED"), false);
  // The other packs are on screen; sending this visitor to support instead of
  // to the pack beside the one they picked would be the wrong next step.
  assert.equal(requiresSupport("PACK_NOT_AVAILABLE_FOR_PLAN"), false);
  assert.equal(isRetryableBillingError("PACK_NOT_AVAILABLE_FOR_PLAN"), false);
  assert.equal(requiresReauthentication("PACK_NOT_AVAILABLE_FOR_PLAN"), false);
});

test("session loading never resolves to a signed-in or signed-out CTA", () => {
  assert.equal(
    resolvePlanCtaState({
      sessionStatus: "loading",
      currentPlan: null,
      cardPlan: "Pro",
      hasActiveSubscription: false,
    }),
    "loading"
  );
  // Authenticated but the authoritative plan has not landed yet: still loading,
  // because guessing here is what rendered a dead "Upgrade" for subscribers.
  assert.equal(
    resolvePlanCtaState({
      sessionStatus: "authenticated",
      currentPlan: null,
      cardPlan: "Pro",
      hasActiveSubscription: false,
    }),
    "loading"
  );
});

test("a signed-out visitor sees the same sign-in CTA on every paid card", () => {
  for (const cardPlan of ["Free", "Pro", "Max"]) {
    assert.equal(
      resolvePlanCtaState({
        sessionStatus: "unauthenticated",
        currentPlan: null,
        cardPlan,
        hasActiveSubscription: false,
      }),
      "signed_out"
    );
  }
});

test("a Free account can start a fresh subscription on either paid plan", () => {
  const forFree = (cardPlan) =>
    resolvePlanCtaState({
      sessionStatus: "authenticated",
      currentPlan: "Free",
      cardPlan,
      hasActiveSubscription: false,
    });

  assert.equal(forFree("Free"), "current_plan");
  assert.equal(forFree("Pro"), "upgrade");
  assert.equal(forFree("Max"), "upgrade");
});

test("Pro is offered the change flow on Max, never a checkout that would 409", () => {
  const forPro = (cardPlan) =>
    resolvePlanCtaState({
      sessionStatus: "authenticated",
      currentPlan: "Pro",
      cardPlan,
      hasActiveSubscription: true,
      currentBillingInterval: "monthly",
    });

  assert.equal(forPro("Pro"), "current_plan");
  assert.equal(forPro("Max"), "change_plan");
  // Free is not a plan change -- it is a cancellation, which lives elsewhere.
  assert.equal(forPro("Free"), "manage_plan");
});

test("Max is never told that Pro is an upgrade", () => {
  const forMax = (cardPlan) =>
    resolvePlanCtaState({
      sessionStatus: "authenticated",
      currentPlan: "Max",
      cardPlan,
      hasActiveSubscription: true,
      currentBillingInterval: "annual",
    });

  assert.equal(forMax("Max"), "current_plan");
  // The same state as the upgrade: one flow, and the server decides the
  // direction again when it is confirmed.
  assert.equal(forMax("Pro"), "change_plan");
  assert.equal(forMax("Free"), "manage_plan");
});

test("an unknown billing interval sends the subscriber to support, not to a refusal", () => {
  // A change only ever happens on the interval already being billed, so
  // without one there is nothing this flow can offer. The value is null for a
  // subscription synced before the field existed.
  const withoutInterval = resolvePlanCtaState({
    sessionStatus: "authenticated",
    currentPlan: "Pro",
    cardPlan: "Max",
    hasActiveSubscription: true,
  });
  assert.equal(withoutInterval, "manage_plan");

  assert.equal(
    resolvePlanCtaState({
      sessionStatus: "authenticated",
      currentPlan: "Pro",
      cardPlan: "Max",
      hasActiveSubscription: true,
      currentBillingInterval: null,
    }),
    "manage_plan"
  );
});

test("a lapsed subscriber buys again rather than changing a subscription that is gone", () => {
  // No live subscription means there is nothing to change: the interval is
  // irrelevant and a fresh checkout is the correct CTA.
  assert.equal(
    resolvePlanCtaState({
      sessionStatus: "authenticated",
      currentPlan: "Pro",
      cardPlan: "Max",
      hasActiveSubscription: false,
      currentBillingInterval: "monthly",
    }),
    "upgrade"
  );
  assert.equal(
    resolvePlanCtaState({
      sessionStatus: "authenticated",
      currentPlan: "Max",
      cardPlan: "Pro",
      hasActiveSubscription: false,
      currentBillingInterval: "monthly",
    }),
    "manage_plan"
  );
});

test("a Free account whose subscription lapsed can check out again", () => {
  // subscriptionCancelAtPeriodEnd has run its course: the account is back on
  // Free with no active Stripe subscription, so a new checkout is correct.
  assert.equal(
    resolvePlanCtaState({
      sessionStatus: "authenticated",
      currentPlan: "Free",
      cardPlan: "Pro",
      hasActiveSubscription: false,
    }),
    "upgrade"
  );
  // Still inside the paid period, plan still Pro: the change flow, not a
  // checkout that would create a second subscription.
  assert.equal(
    resolvePlanCtaState({
      sessionStatus: "authenticated",
      currentPlan: "Pro",
      cardPlan: "Max",
      hasActiveSubscription: true,
      currentBillingInterval: "monthly",
    }),
    "change_plan"
  );
});

test("the Free card stops advertising sign-up to people who already pay", () => {
  assert.equal(shouldHideFreePlanCta("authenticated", "Pro"), true);
  assert.equal(shouldHideFreePlanCta("authenticated", "Max"), true);
  assert.equal(shouldHideFreePlanCta("authenticated", "Free"), false);
  assert.equal(shouldHideFreePlanCta("unauthenticated", null), false);
  assert.equal(shouldHideFreePlanCta("loading", null), false);
});
