import test from "node:test";
import assert from "node:assert/strict";
import { createAccountSettingsApi } from "../src/host/account-settings-api";
import { billingRequest, createBillingApi } from "../src/host/billing-api";
import { readDesktopCapabilities } from "../src/host/desktop-capabilities";
import {
  checkoutReturnOutcome, classifyCheckoutNavigation, desktopBillingInput, desktopBillingResponse, isTomverseUrl, purchaseConfirmed,
  purchaseItem, stripeCheckoutUrl, type CheckoutPurpose,
} from "../src/billing-contract";

const origin = "https://tomverse.example";
const fixtureCookie = "fixture..account.settings.signature";
const attempt = "6f1d3c9e-6a55-4a4c-9f3e-2f3b8b8f6a01";

type Call = { url: URL; method: string; body: unknown; headers: Headers };

/**
 * The billing API over a fake account origin. The account's usage and the pack list are answered here
 * (and not recorded in `calls`): `account.plan`/`account.purchased` are what the server reports now.
 */
function fixture(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const opened: { url: URL; purpose: CheckoutPurpose }[] = [];
  const state = { plan: "Free" as "Free" | "Pro" | "Max", purchased: 0, usageReads: 0, changes: 0 };
  let windowOpen = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/desktop/settings-session") {
      return Response.json({ token: fixtureCookie, expiresAt: Date.now() + 300_000 });
    }
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/user/usage") {
      state.usageReads += 1;
      return Response.json(usage(state.plan, state.purchased));
    }
    if (url.pathname === "/api/billing/credit-packs" && method === "GET") return Response.json({ plan: state.plan, packs: [
      { id: "starter_500", name: "Starter", credits: 500, priceMinor: 500, currency: "USD", validityDays: 90 },
      { id: "project_1500", name: "Project", credits: 1_500, priceMinor: 1_200, currency: "USD", validityDays: 90 },
    ] });
    const call = { url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) };
    calls.push(call);
    return respond(call);
  };
  const account = new AbortController();
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", account.signal, transport);
  const api = createBillingApi(settings, {
    accountSignal: account.signal,
    timeZone: () => "Australia/Brisbane",
    checkoutOpen: () => windowOpen,
    openCheckout: (url, purpose) => { opened.push({ url, purpose }); windowOpen = true; },
    purchasesChanged: () => { state.changes += 1; },
    wait: async () => {},
  });
  return { billing: api.billing, api, calls, opened, account, state, setWindowOpen: (value: boolean) => { windowOpen = value; } };
}

/** Lets the account checks the tracker started in the background run to their end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const quote = {
  requestId: "pcr_123", direction: "upgrade", execution: "immediate_upgrade", fromTier: "Pro", toTier: "Max",
  billingInterval: "monthly", currency: "aud", amountDueMinor: 1250,
  credits: { monthlyPlanCredits: 10_000, planCreditsUsedThisMonth: 800, creditDebtCredits: 0, remainingPlanCredits: 9_200, overageCredits: 0 },
  effectiveAt: null, renewal: "cancellation_preserved", expiresAt: "2026-11-25T10:00:00.000Z",
};
const reservation = {
  requestId: "pcr_123", direction: "upgrade", execution: "immediate_upgrade", fromTier: "Pro", toTier: "Max",
  billingInterval: "monthly", status: "pending", appliesAt: null, cancellable: false,
};
const usage = (plan: "Free" | "Pro" | "Max", purchased: number) => ({
  plan,
  subscription: { status: plan === "Free" ? null : "active", billingInterval: plan === "Free" ? null : "monthly",
    currentPeriodEnd: plan === "Free" ? null : "2026-12-20T00:00:00.000Z", cancelAtPeriodEnd: false },
  balances: { dailyRemainingCredits: 30, dailyResetsAt: "2026-11-26T00:00:00.000Z", planRemainingCredits: 300,
    planResetsAt: "2026-12-01T00:00:00.000Z", purchasedRemainingCredits: purchased, purchasedFundedCostMicroUsd: 0,
    purchasedEarliestExpiry: null },
  usage: { creditsDay: 0, creditsMonth: 0 }, limits: { creditsDay: 30, creditsMonth: 300 },
});

test("the billing IPC names actions only and refuses paths, extra fields and consent the customer did not give", () => {
  assert.equal(desktopBillingInput.safeParse({ action: "usage", path: "/api/admin/billing" }).success, false);
  assert.equal(desktopBillingInput.safeParse({ action: "checkout", planId: "pro", billingInterval: "monthly", currency: "USD",
    language: "ko", purchaseAttemptId: attempt, returnTo: "https://other.example" }).success, false);
  assert.equal(desktopBillingInput.safeParse({ action: "checkout", planId: "free", billingInterval: "monthly", currency: "USD",
    language: "ko", purchaseAttemptId: attempt }).success, false);
  assert.equal(desktopBillingInput.safeParse({ action: "checkout", planId: "pro", billingInterval: "monthly", currency: "USD",
    language: "ko", purchaseAttemptId: "retry" }).success, false);
  assert.equal(desktopBillingInput.safeParse({ action: "confirmPlanChange", requestId: "../admin" }).success, false);
  // Resuming renewal is only ever an explicit yes; a false cannot be smuggled through as consent.
  assert.equal(desktopBillingInput.safeParse({ action: "confirmPlanChange", requestId: "pcr_1", resumeRenewal: false }).success, false);
  assert.equal(desktopBillingInput.safeParse({ action: "requestRefund", reason: "x".repeat(1_001) }).success, false);
  assert.equal(desktopBillingInput.safeParse({ action: "buyCreditPack", packId: "starter_500", currency: "USD", language: "en",
    amountMinor: 1 }).success, false);
  const promo = desktopBillingInput.parse({ action: "validatePromotion", planId: "max", billingInterval: "annual",
    promoCode: " tomverse50 ", currency: "AUD" });
  assert.deepEqual(promo, { action: "validatePromotion", planId: "max", billingInterval: "annual", promoCode: "TOMVERSE50", currency: "AUD" });
  // The purchase records are read and re-checked by item name only; a warning token is a UUID the main process issued.
  assert.equal(desktopBillingInput.safeParse({ action: "purchases" }).success, true);
  assert.equal(desktopBillingInput.safeParse({ action: "purchases", account: "other" }).success, false);
  for (const item of ["subscription", "credits:starter_500"]) {
    assert.equal(desktopBillingInput.safeParse({ action: "checkPurchase", item }).success, true, item);
  }
  for (const item of ["credits:", "credits:../x", "credits:Starter", "subscription:pro", "", 5]) {
    assert.equal(desktopBillingInput.safeParse({ action: "checkPurchase", item }).success, false, String(item));
  }
  assert.equal(desktopBillingInput.safeParse({ action: "buyCreditPack", packId: "starter_500", currency: "USD", language: "en",
    repeatHold: "seen-the-warning" }).success, false);
  assert.equal(desktopBillingInput.safeParse({ action: "buyCreditPack", packId: "starter_500", currency: "USD", language: "en",
    repeatHold: true }).success, false);
});

test("every action maps to the web's own billing route with the web's request body", () => {
  const map = (value: unknown) => {
    const input = desktopBillingInput.parse(value);
    assert.ok(!["closeCheckout", "purchases", "checkPurchase"].includes(input.action));
    return billingRequest(input as Parameters<typeof billingRequest>[0], "Asia/Seoul");
  };
  assert.deepEqual(map({ action: "usage" }), { path: "/api/user/usage" });
  assert.deepEqual(map({ action: "config" }), { path: "/api/billing/config?tz=Asia%2FSeoul" });
  assert.deepEqual(map({ action: "creditPacks" }), { path: "/api/billing/credit-packs?tz=Asia%2FSeoul" });
  assert.deepEqual(map({ action: "planChange" }), { path: "/api/billing/plan-change" });
  assert.deepEqual(map({ action: "refundStatus" }), { path: "/api/billing/refund-request" });
  assert.deepEqual(map({ action: "checkout", planId: "max", billingInterval: "annual", currency: "KRW", language: "ko",
    purchaseAttemptId: attempt }), { path: "/api/billing/checkout", method: "POST", body: {
    planId: "max", billingInterval: "annual", language: "ko", currency: "KRW", purchaseAttemptId: attempt } });
  assert.deepEqual(map({ action: "buyCreditPack", packId: "project_1500", currency: "EUR", language: "de" }),
    { path: "/api/billing/credit-packs", method: "POST", body: { packId: "project_1500", language: "de", currency: "EUR" } });
  // The main process's warning token stays in the main process.
  assert.deepEqual(map({ action: "buyCreditPack", packId: "project_1500", currency: "EUR", language: "de", repeatHold: attempt }),
    { path: "/api/billing/credit-packs", method: "POST", body: { packId: "project_1500", language: "de", currency: "EUR" } });
  assert.deepEqual(map({ action: "checkout", planId: "pro", billingInterval: "monthly", currency: "USD", language: "en",
    purchaseAttemptId: attempt, repeatHold: attempt }).body, { planId: "pro", billingInterval: "monthly", language: "en", currency: "USD",
    purchaseAttemptId: attempt });
  assert.deepEqual(map({ action: "previewPlanChange", targetTier: "Pro", billingInterval: "annual" }),
    { path: "/api/billing/plan-change/preview", method: "POST", body: { targetTier: "Pro", billingInterval: "annual" } });
  assert.deepEqual(map({ action: "confirmPlanChange", requestId: "pcr_1" }),
    { path: "/api/billing/plan-change/confirm", method: "POST", body: { requestId: "pcr_1" } });
  assert.deepEqual(map({ action: "cancelPlanChange" }), { path: "/api/billing/plan-change", method: "DELETE" });
  // An unknown interval is left out; the server quotes on the one Stripe reports.
  assert.deepEqual(map({ action: "previewPlanChange", targetTier: "Pro" }),
    { path: "/api/billing/plan-change/preview", method: "POST", body: { targetTier: "Pro" } });
  assert.deepEqual(map({ action: "cancelSubscription" }), { path: "/api/billing/cancel-subscription", method: "POST", body: {} });
  assert.deepEqual(map({ action: "resumeRenewal" }), { path: "/api/billing/cancel-subscription", method: "DELETE" });
  assert.deepEqual(map({ action: "requestRefund", reason: "  charged twice " }),
    { path: "/api/billing/refund-request", method: "POST", body: { reason: "charged twice" } });
  assert.deepEqual(billingRequest({ action: "config" }, null), { path: "/api/billing/config" });
});

test("only an https URL on Stripe's Checkout host is opened", () => {
  assert.equal(stripeCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_a1#fid")?.hostname, "checkout.stripe.com");
  for (const value of [
    "http://checkout.stripe.com/c/pay/cs_test_a1", "https://checkout.stripe.com.evil.example/c/pay",
    "https://evil.example/?next=https://checkout.stripe.com", "https://user:pass@checkout.stripe.com/c/pay",
    "https://checkout.stripe.com:8443/c/pay", "https://stripe.com/c/pay", "https://pay.stripe.com/c/pay",
    "javascript:alert(1)", "not a url", 42, null, "https://checkout.stripe.com/" + "a".repeat(8_200),
  ]) assert.equal(stripeCheckoutUrl(value), null, String(value).slice(0, 80));
});

test("the checkout window keeps Stripe and 3-D Secure hosts, closes on a Tomverse page and blocks everything else", () => {
  const origins = ["https://tomverse.app", "http://127.0.0.1:4300"];
  assert.equal(classifyCheckoutNavigation("https://checkout.stripe.com/c/pay/cs_live_1", origins), "allow");
  assert.equal(classifyCheckoutNavigation("https://hooks.stripe.com/3d_secure_2/hosted", origins), "allow");
  assert.equal(classifyCheckoutNavigation("https://acs.issuer-bank.example.com/challenge", origins), "allow");
  assert.equal(classifyCheckoutNavigation("https://tomverse.app/chat?billing=success&plan=pro", origins), "return");
  assert.equal(classifyCheckoutNavigation("https://dev.tomverse.app/pricing?billing=cancelled", origins), "return");
  assert.equal(classifyCheckoutNavigation("http://127.0.0.1:4300/review?billing=credits-success", origins), "return");
  for (const value of ["http://acs.example.com/challenge", "https://localhost/pay", "https://10.0.0.1/", "file:///C:/x",
    "data:text/html,hi", "https://user:pw@tomverse.app/chat", "http://tomverse.app.evil.example/"]) {
    assert.equal(classifyCheckoutNavigation(value, origins), "block", value);
  }
  assert.equal(isTomverseUrl("https://tomverse.app.evil.example/chat", origins), false);
  assert.equal(isTomverseUrl("https://eviltomverse.app/chat", origins), false);
  assert.equal(checkoutReturnOutcome("https://tomverse.app/chat?billing=success&plan=max"), "success");
  assert.equal(checkoutReturnOutcome("https://tomverse.app/review?billing=credits-success&pack=starter_500"), "success");
  assert.equal(checkoutReturnOutcome("https://tomverse.app/pricing?billing=cancelled#plans"), "cancelled");
  assert.equal(checkoutReturnOutcome("https://tomverse.app/review?billing=credits-cancelled"), "cancelled");
  assert.equal(checkoutReturnOutcome("https://tomverse.app/chat"), "returned");
});

test("a purchase counts as done only when the account the server reports shows it", () => {
  const before = usage("Free", 0);
  assert.equal(purchaseConfirmed({ kind: "subscription", planId: "pro" }, before, usage("Free", 0)), false);
  assert.equal(purchaseConfirmed({ kind: "subscription", planId: "pro" }, before, usage("Max", 0)), false);
  assert.equal(purchaseConfirmed({ kind: "subscription", planId: "pro" }, before, usage("Pro", 0)), true);
  assert.equal(purchaseConfirmed({ kind: "subscription", planId: "max" }, usage("Max", 0), usage("Max", 0)), false);
  assert.equal(purchaseConfirmed({ kind: "credits", packId: "starter_500" }, usage("Pro", 100), usage("Pro", 100)), false);
  assert.equal(purchaseConfirmed({ kind: "credits", packId: "starter_500" }, usage("Pro", 100), usage("Pro", 600)), true);
});

test("one record per item: any subscription plan shares one, each credit pack has its own", () => {
  assert.equal(purchaseItem({ kind: "subscription", planId: "pro" }), "subscription");
  // One account holds one subscription: a different plan would still be a second subscription.
  assert.equal(purchaseItem({ kind: "subscription", planId: "max" }), "subscription");
  assert.equal(purchaseItem({ kind: "credits", packId: "starter_500" }), "credits:starter_500");
  assert.notEqual(purchaseItem({ kind: "credits", packId: "project_1500" }), purchaseItem({ kind: "credits", packId: "starter_500" }));
});

const pack = (packId: string, repeatHold?: string) =>
  ({ action: "buyCreditPack", packId, currency: "USD", language: "en", ...(repeatHold ? { repeatHold } : {}) }) as const;
const subscription = (repeatHold?: string) => ({ action: "checkout", planId: "pro", billingInterval: "monthly", currency: "USD",
  language: "en", purchaseAttemptId: attempt, ...(repeatHold ? { repeatHold } : {}) }) as const;
const stripe = () => Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test_fixture" });
const posts = (calls: Call[], path: string) => calls.filter((call) => call.method === "POST" && call.url.pathname === path).length;

test("the main process keeps each unconfirmed purchase: another pack or the subscription does not replace pack A's record", async () => {
  const { billing, api, calls, state, setWindowOpen } = fixture(stripe);
  const close = async (outcome: "success" | "cancelled" | "closed") => { setWindowOpen(false); api.checkoutClosed(outcome); await settle(); };
  // Pack A comes back on the cancel page and the account never shows it.
  assert.deepEqual(await billing(pack("starter_500")), { ok: true, value: { kind: "window" } });
  await close("cancelled");
  assert.deepEqual(api.purchases().map(({ item, stage, cancelled }) => [item, stage, cancelled]),
    [["credits:starter_500", "unconfirmed", true]]);
  // Pack B lands; A's record stays unconfirmed, because B's credits explain the whole increase.
  assert.deepEqual(await billing(pack("project_1500")), { ok: true, value: { kind: "window" } });
  state.purchased += 1_500;
  await close("closed");
  // The subscription is bought too and not shown yet.
  assert.deepEqual(await billing(subscription()), { ok: true, value: { kind: "window" } });
  await close("success");
  assert.deepEqual(api.purchases().map(({ item, stage }) => [item, stage]), [
    ["credits:starter_500", "unconfirmed"], ["subscription", "unconfirmed"],
  ]);
  // Buying pack A again: the account is read first and the main process holds the checkout back.
  const reads = state.usageReads;
  const before = posts(calls, "/api/billing/credit-packs");
  const held = await billing(pack("starter_500"));
  assert.equal(held.ok && (held.value as { kind: string }).kind, "held");
  assert.equal(state.usageReads, reads + 1);
  assert.equal(posts(calls, "/api/billing/credit-packs"), before);
  // So does another subscription plan.
  const max = await billing({ ...subscription(), planId: "max" });
  assert.equal(max.ok && (max.value as { kind: string }).kind, "held");
  assert.equal(posts(calls, "/api/billing/checkout"), 1);
  // A different pack is a different item and goes ahead.
  assert.deepEqual(await billing(pack("project_1500")), { ok: true, value: { kind: "window" } });
});

test("a repeat goes ahead only with the hold the main process issued, once; a made-up hold is answered with a new warning", async () => {
  const { billing, api, calls, setWindowOpen } = fixture(stripe);
  const close = async () => { setWindowOpen(false); api.checkoutClosed("closed"); await settle(); };
  const holdOf = (result: Awaited<ReturnType<typeof billing>>) => {
    assert.ok(result.ok);
    const value = result.value as { kind: string; hold?: string };
    assert.equal(value.kind, "held");
    return value.hold!;
  };
  await billing(pack("starter_500"));
  await close();
  await billing(subscription());
  await close();
  // The renderer claims the customer chose to repeat, without the main process having warned: refused.
  holdOf(await billing(pack("starter_500", "0b6f6b50-3d1c-4a0e-8a43-5d4b7c3f9a11")));
  assert.equal(posts(calls, "/api/billing/credit-packs"), 1);
  // A hold issued for the subscription is not one for this pack.
  const subscriptionHold = holdOf(await billing(subscription()));
  holdOf(await billing(pack("starter_500", subscriptionHold)));
  // A newer warning replaces the earlier hold.
  const first = holdOf(await billing(pack("starter_500")));
  const second = holdOf(await billing(pack("starter_500")));
  assert.notEqual(first, second);
  const third = holdOf(await billing(pack("starter_500", first)));
  assert.equal(posts(calls, "/api/billing/credit-packs"), 1);
  // The customer's choice in the latest warning opens the checkout, once.
  assert.deepEqual(await billing(pack("starter_500", third)), { ok: true, value: { kind: "window" } });
  assert.equal(posts(calls, "/api/billing/credit-packs"), 2);
  await close();
  holdOf(await billing(pack("starter_500", third)));
  assert.equal(posts(calls, "/api/billing/credit-packs"), 2);
  assert.equal(posts(calls, "/api/billing/checkout"), 1);
});

test("a repeat whose earlier payment the fresh read now shows opens nothing and reports it settled", async () => {
  const { billing, api, calls, state, setWindowOpen } = fixture(stripe);
  await billing(pack("starter_500"));
  setWindowOpen(false);
  api.checkoutClosed("cancelled");
  await settle();
  assert.equal(api.purchases()[0].stage, "unconfirmed");
  state.purchased = 500;
  assert.deepEqual(await billing(pack("starter_500")), { ok: true, value: { kind: "settled" } });
  assert.equal(api.purchases()[0].stage, "confirmed");
  assert.equal(posts(calls, "/api/billing/credit-packs"), 1);
  // Buying it again now is a new purchase.
  assert.deepEqual(await billing(pack("starter_500")), { ok: true, value: { kind: "window" } });
});

test("the account check after the window closes runs in the main process with nothing on screen, and stops with the account", async () => {
  const { billing, api, account, state, setWindowOpen } = fixture(stripe);
  await billing(pack("starter_500"));
  assert.deepEqual(api.purchases().map(({ stage }) => stage), ["open"]);
  // No renderer is involved: the close alone starts the reads, and a late payment ends confirmed.
  const reads = state.usageReads;
  setWindowOpen(false);
  api.checkoutClosed("cancelled");
  state.purchased = 500;
  await settle();
  assert.ok(state.usageReads > reads);
  assert.deepEqual(api.purchases().map(({ stage, cancelled }) => [stage, cancelled]), [["confirmed", true]]);
  // An unconfirmed record, then the account session ends: nothing is kept and a later close checks nothing.
  await billing(pack("project_1500"));
  setWindowOpen(false);
  api.checkoutClosed("closed");
  await settle();
  assert.equal(api.purchases().length, 1);
  const changes = state.changes;
  account.abort();
  assert.deepEqual(api.purchases(), []);
  assert.ok(state.changes > changes, "the emptied list is published");
  const after = state.usageReads;
  api.checkoutClosed("closed");
  await settle();
  assert.equal(state.usageReads, after);
  await assert.rejects(billing({ action: "checkPurchase", item: "credits:project_1500" }), { name: "AbortError" });
});

test("server responses are parsed to the fields the screen uses", () => {
  const parsed = desktopBillingResponse.usage.parse({ ...usage("Pro", 10), subscription: { ...usage("Pro", 10).subscription,
    billingInterval: "quarterly" } });
  assert.equal(parsed.subscription.billingInterval, null);
  assert.equal("purchasedFundedCostMicroUsd" in parsed.balances, false);
  const config = desktopBillingResponse.config.parse({
    plans: [{ id: "pro", name: "Pro", tier: "Pro", monthlyPriceCents: 1500, annualPriceCents: 14_400, monthlyMessageLimit: 3000,
      displayCurrency: "AUD", displayMonthlyPriceMinor: 2000, displayAnnualPriceMinor: 19_200, stripePriceId: "price_x" }],
    featuredPromotion: { code: "TOMVERSE50", appliesToPlanIds: ["pro", "max"], billingIntervals: ["monthly"], discountPercent: 50 },
    displayCurrency: "AUD", displayCountry: "AU", appInputTokenLimit: 128_000,
  });
  assert.equal("stripePriceId" in config.plans[0], false);
  assert.equal(desktopBillingResponse.config.parse({ ...config, featuredPromotion: { code: 5 } }).featuredPromotion, null);
  assert.equal(desktopBillingResponse.checkout.safeParse({ success: true, redirectUrl: "https://tomverse.app/chat",
    periodEnd: "2027-01-20T00:00:00.000Z", accessType: "founding_tester_pass" }).success, true);
  assert.equal(desktopBillingResponse.checkout.safeParse({ url: null }).success, false);
});

test("a plan change is quoted, then confirmed with the quoted request id and only the renewal consent that was ticked", async () => {
  const { billing, calls } = fixture(({ url }) => url.pathname.endsWith("/preview")
    ? Response.json({ success: true, quote }) : Response.json({ success: true, reservation }));
  const preview = await billing({ action: "previewPlanChange", targetTier: "Max", billingInterval: "monthly" });
  assert.equal(preview.ok, true);
  const quoted = (preview as { value: { quote: typeof quote } }).value.quote;
  assert.equal(quoted.requestId, "pcr_123");
  assert.equal("planCreditsUsedThisMonth" in quoted.credits!, false);
  await billing({ action: "confirmPlanChange", requestId: quoted.requestId });
  await billing({ action: "confirmPlanChange", requestId: quoted.requestId, resumeRenewal: true });
  assert.deepEqual(calls.map(({ url, method, body }) => [method, url.pathname, body]), [
    ["POST", "/api/billing/plan-change/preview", { targetTier: "Max", billingInterval: "monthly" }],
    ["POST", "/api/billing/plan-change/confirm", { requestId: "pcr_123" }],
    ["POST", "/api/billing/plan-change/confirm", { requestId: "pcr_123", resumeRenewal: true }],
  ]);
  for (const { url, headers } of calls) {
    assert.equal(url.origin, origin);
    assert.equal(headers.get("cookie"), "__Secure-next-auth.session-token=" + fixtureCookie);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("origin"), origin);
  }
});

test("cancellation, a refund request and promotion validation send the web's request and pass on only the server's code", async () => {
  const { billing, calls } = fixture(({ url }) => {
    if (url.pathname === "/api/billing/cancel-subscription") {
      return Response.json({ success: true, cancelAtPeriodEnd: true, currentPeriodEnd: "2026-12-20T00:00:00.000Z", status: "active" });
    }
    if (url.pathname === "/api/billing/refund-request") {
      return Response.json({ error: "A refund request is already pending." }, { status: 409 });
    }
    return Response.json({ valid: false, code: "PROMOTION_CURRENCY_NOT_SUPPORTED", error: "Fixed-amount codes are USD only." },
      { status: 400 });
  });
  assert.deepEqual(await billing({ action: "cancelSubscription" }), { ok: true, value: {
    cancelAtPeriodEnd: true, currentPeriodEnd: "2026-12-20T00:00:00.000Z" } });
  assert.deepEqual(await billing({ action: "requestRefund", reason: "Charged twice" }), { ok: false, status: 409, code: null });
  assert.deepEqual(await billing({ action: "validatePromotion", planId: "pro", billingInterval: "monthly", promoCode: "PAYMENTTEST27",
    currency: "AUD" }), { ok: false, status: 400, code: "PROMOTION_CURRENCY_NOT_SUPPORTED" });
  assert.deepEqual(calls.map(({ url, method, body }) => [method, url.pathname, body]), [
    ["POST", "/api/billing/cancel-subscription", {}],
    ["POST", "/api/billing/refund-request", { reason: "Charged twice" }],
    ["POST", "/api/billing/promotion/validate", { planId: "pro", billingInterval: "monthly", promoCode: "PAYMENTTEST27", currency: "AUD" }],
  ]);
});

test("checkout opens only a verified Stripe URL, outside the account session, and never twice at once", async () => {
  let reply: unknown = { url: "https://checkout.stripe.com/c/pay/cs_test_a1#fidkdWx" };
  const { billing, api, calls, opened, state, setWindowOpen } = fixture(() => Response.json(reply));
  const input = { action: "checkout", planId: "pro", billingInterval: "monthly", currency: "USD", language: "en",
    purchaseAttemptId: attempt } as const;
  assert.deepEqual(await billing(input), { ok: true, value: { kind: "window" } });
  assert.deepEqual(opened.map(({ url, purpose }) => [url.href, purpose]),
    [["https://checkout.stripe.com/c/pay/cs_test_a1#fidkdWx", "subscription"]]);
  // A second purchase attempt while the window is open never reaches the server.
  assert.deepEqual(await billing({ ...input, purchaseAttemptId: "0b6f6b50-3d1c-4a0e-8a43-5d4b7c3f9a11" }),
    { ok: false, status: 0, code: "CHECKOUT_WINDOW_OPEN" });
  assert.equal(calls.length, 1);
  // The window closes and the account shows the plan.
  setWindowOpen(false);
  state.plan = "Pro";
  api.checkoutClosed("success");
  await settle();
  reply = { url: "https://checkout.stripe.com.evil.example/c/pay/cs_test_a1" };
  assert.deepEqual(await billing(input), { ok: false, status: 200, code: "CHECKOUT_URL_REJECTED" });
  reply = { url: "https://checkout.stripe.com/c/pay/cs_test_b2" };
  assert.deepEqual(await billing({ action: "buyCreditPack", packId: "starter_500", currency: "USD", language: "en" }),
    { ok: true, value: { kind: "window" } });
  assert.equal(opened.length, 2);
  assert.equal(opened[1].purpose, "credits");
  setWindowOpen(false);
  state.purchased = 500;
  api.checkoutClosed("closed");
  await settle();
  reply = { success: true, redirectUrl: "https://tomverse.app/chat?billing=success&access=founding-tester-pass",
    periodEnd: "2027-01-24T00:00:00.000Z", accessType: "founding_tester_pass", automaticRenewal: false };
  assert.deepEqual(await billing({ ...input, promoCode: "TOMFRIEND100" }),
    { ok: true, value: { kind: "pass", periodEnd: "2027-01-24T00:00:00.000Z" } });
  // A pass redirect is never opened: nothing was paid and no window is needed.
  assert.equal(opened.length, 2);
  assert.deepEqual(calls.at(-1)?.body, { planId: "pro", billingInterval: "monthly", language: "en", currency: "USD",
    purchaseAttemptId: attempt, promoCode: "TOMFRIEND100" });
});

test("a lost connection is reported as an unknown outcome and a sign-in lapse renews the session on the next call", async () => {
  let mode: "drop" | "expired" | "ok" = "drop";
  const sessions: number[] = [];
  const account = new AbortController();
  const transport: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/desktop/settings-session") {
      sessions.push(Date.now());
      return Response.json({ token: fixtureCookie, expiresAt: Date.now() + 300_000 });
    }
    if (mode === "drop") throw new TypeError("fetch failed");
    if (mode === "expired") return Response.json({ code: "AUTHENTICATION_REQUIRED", error: "Authentication required." }, { status: 401 });
    return Response.json({ reservation: null });
  };
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", account.signal, transport);
  const { billing } = createBillingApi(settings, { accountSignal: account.signal, timeZone: () => null, checkoutOpen: () => false,
    openCheckout: () => assert.fail("no checkout") });
  assert.deepEqual(await billing({ action: "confirmPlanChange", requestId: "pcr_1" }), { ok: false, status: 0, code: "NETWORK_ERROR" });
  mode = "expired";
  assert.deepEqual(await billing({ action: "planChange" }), { ok: false, status: 401, code: "AUTHENTICATION_REQUIRED" });
  mode = "ok";
  assert.deepEqual(await billing({ action: "planChange" }), { ok: true, value: { reservation: null } });
  assert.equal(sessions.length, 2);
  account.abort();
  await assert.rejects(billing({ action: "planChange" }), { name: "AbortError" });
});

test("the billing screens stay hidden unless the server reports the Desktop billing capability", async (t) => {
  let body: Record<string, unknown> = { autoSelection: { offered: false } };
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const read = () => readDesktopCapabilities("fixture-access", new AbortController().signal, "http://127.0.0.1");
  assert.equal((await read())?.billing, false);
  body = { ...body, desktopBilling: false };
  assert.equal((await read())?.billing, false);
  body = { ...body, desktopBilling: true };
  assert.equal((await read())?.billing, true);
});
